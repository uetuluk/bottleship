#!/usr/bin/env tsx

/**
 * Log Manager Tool for BottleShip
 *
 * Senior developer utilities for managing logs efficiently.
 * Handles log cleanup, analysis, and optimization.
 */

import { readdir, lstat, unlink, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

const LOG_DIR = "logs";

interface LogStats {
  totalFiles: number;
  totalSize: number;
  oldestFile: string | null;
  newestFile: string | null;
  averageSize: number;
  sizeDistribution: { [key: string]: number };
}

class LogManager {
  constructor(private readonly root = LOG_DIR) {}

  private async listFiles(): Promise<Array<{ path: string; size: number; mtimeMs: number }>> {
    const files: Array<{ path: string; size: number; mtimeMs: number }> = [];
    const pending = [this.root];
    while (pending.length) {
      const dir = pending.pop()!;
      let entries: string[];
      try { entries = await readdir(dir); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const name of entries) {
        const path = join(dir, name);
        try {
          const info = await lstat(path);
          if (info.isSymbolicLink()) continue;
          if (info.isDirectory()) pending.push(path);
          else if (info.isFile()) files.push({ path, size: info.size, mtimeMs: info.mtimeMs });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
    return files;
  }

  async getStats(): Promise<LogStats> {
    const stats = await this.listFiles();
    if (stats.length === 0) {
      return {
        totalFiles: 0,
        totalSize: 0,
        oldestFile: null,
        newestFile: null,
        averageSize: 0,
        sizeDistribution: {},
      };
    }

    const totalSize = stats.reduce((sum, s) => sum + s.size, 0);
    const sortedByTime = stats.sort((a, b) => a.mtimeMs - b.mtimeMs);

    const sizeDistribution: { [key: string]: number } = {};
    stats.forEach(s => {
      const sizeRange = this.getSizeRange(s.size);
      sizeDistribution[sizeRange] = (sizeDistribution[sizeRange] || 0) + 1;
    });

    return {
      totalFiles: stats.length,
      totalSize,
      oldestFile: sortedByTime[0]?.path || null,
      newestFile: sortedByTime[sortedByTime.length - 1]?.path || null,
      averageSize: totalSize / stats.length,
      sizeDistribution,
    };
  }

  private getSizeRange(size: number): string {
    const mb = size / (1024 * 1024);
    if (mb < 10) return "<10MB";
    if (mb < 50) return "10-50MB";
    if (mb < 100) return "50-100MB";
    if (mb < 500) return "100-500MB";
    return ">500MB";
  }

  async cleanup(options: {
    maxAgeDays?: number;
    maxTotalSizeMB?: number;
    keepRecent?: number;
    dryRun?: boolean;
  } = {}): Promise<{ deleted: string[], totalFreed: number }> {
    const {
      maxAgeDays = 1, // Keep only 1 day by default
      maxTotalSizeMB = 100, // Max 100MB total
      keepRecent = 3, // Always keep 3 most recent
      dryRun = false
    } = options;

    for (const value of [maxAgeDays, maxTotalSizeMB, keepRecent]) {
      if (!Number.isFinite(value) || value < 0) throw new Error("Cleanup limits must be nonnegative finite numbers");
    }
    const stats = await this.listFiles();

    const now = Date.now();
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    const maxTotalBytes = maxTotalSizeMB * 1024 * 1024;

    // Sort by modification time (newest first)
    stats.sort((a, b) => b.mtimeMs - a.mtimeMs);

    let totalSize = stats.reduce((sum, s) => sum + s.size, 0);
    const toDelete: string[] = [];
    let freedBytes = 0;

    const candidates = stats.filter(f => /\.(?:log|jsonl|png|heapsnapshot|json\.gz|harness\.ts)$/i.test(f.path));
    const keepFiles = new Set<string>();
    const perDirectory = new Map<string, number>();
    for (const file of candidates) {
      const dir = dirname(file.path), count = perDirectory.get(dir) ?? 0;
      if (count < keepRecent) keepFiles.add(file.path);
      perDirectory.set(dir, count + 1);
    }

    for (const file of candidates.toReversed()) {
      const shouldDelete =
        !keepFiles.has(file.path) && ((now - file.mtimeMs > maxAgeMs) || totalSize > maxTotalBytes);

      if (shouldDelete) {
        if (!dryRun) {
          try {
            const current = await lstat(file.path);
            // A live writer may have appended since the census.
            if (!current.isFile() || current.size !== file.size || current.mtimeMs !== file.mtimeMs) continue;
            await unlink(file.path);
          } catch (error) {
            if (["ENOENT", "EBUSY", "EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
            throw error;
          }
        }
        toDelete.push(file.path);
        freedBytes += file.size;
        totalSize -= file.size;
      }
    }

    return { deleted: toDelete, totalFreed: freedBytes };
  }

  async emergencyCleanup(): Promise<{ deleted: string[], totalFreed: number }> {
    console.log("🚨 EMERGENCY LOG CLEANUP - Keeping only last 24 hours and 50MB total");

    return this.cleanup({
      maxAgeDays: 1,
      maxTotalSizeMB: 50,
      keepRecent: 2,
      dryRun: false
    });
  }

  async archiveAndCompress(targetPath?: string): Promise<string> {
    const archivePath = targetPath || `bottleship-logs-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.tar.gz`;

    // Ensure directory exists
    await mkdir(dirname(archivePath), { recursive: true });

    // Create a simple text archive (tar.gz would require external tools)
    const files = (await this.listFiles()).filter(f => /\.(?:log|jsonl|md)$/i.test(f.path));

    let archiveContent = `BottleShip Log Archive - ${new Date().toISOString()}\n`;
    archiveContent += `Files archived: ${files.length}\n\n`;

    for (const file of files) {
      const content = await Bun.file(file.path).text();
      archiveContent += `=== ${file.path} ===\n${content}\n\n`;
    }

    await writeFile(archivePath, archiveContent);
    return archivePath;
  }

  formatBytes(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unitIndex = 0;

    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex++;
    }

    return `${value.toFixed(1)}${units[unitIndex]}`;
  }
}

// CLI Interface
async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'stats';

  const manager = new LogManager();

  switch (command) {
    case 'stats':
      const stats = await manager.getStats();
      console.log('📊 Log Statistics:');
      console.log(`   Files: ${stats.totalFiles}`);
      console.log(`   Total size: ${manager.formatBytes(stats.totalSize)}`);
      console.log(`   Average size: ${manager.formatBytes(stats.averageSize)}`);
      console.log(`   Oldest: ${stats.oldestFile || 'none'}`);
      console.log(`   Newest: ${stats.newestFile || 'none'}`);
      console.log('   Size distribution:', stats.sizeDistribution);
      break;

    case 'cleanup':
      const maxAge = args[1] ? parseInt(args[1]) : 1;
      const maxSize = args[2] ? parseInt(args[2]) : 100;
      console.log(`🧹 Cleaning logs older than ${maxAge} days, keeping under ${maxSize}MB...`);
      const result = await manager.cleanup({
        maxAgeDays: maxAge,
        maxTotalSizeMB: maxSize,
        dryRun: args.includes('--dry-run')
      });
      console.log(`   Deleted ${result.deleted.length} files`);
      console.log(`   Freed ${manager.formatBytes(result.totalFreed)}`);
      if (args.includes('--dry-run')) {
        console.log('   (Dry run - no files actually deleted)');
      }
      break;

    case 'emergency':
      console.log('🚨 Emergency cleanup activated!');
      const emergency = await manager.emergencyCleanup();
      console.log(`   Deleted ${emergency.deleted.length} files`);
      console.log(`   Freed ${manager.formatBytes(emergency.totalFreed)}`);
      break;

    case 'archive':
      const archivePath = args[1] || `bottleship-logs-emergency-${Date.now()}.txt`;
      console.log(`📦 Archiving logs to ${archivePath}...`);
      await manager.archiveAndCompress(archivePath);
      console.log('   Archive created successfully');
      break;

    default:
      console.log('Usage:');
      console.log('  log-manager stats                    # Show log statistics');
      console.log('  log-manager cleanup [days] [maxMB]   # Clean old logs (default: 1 day, 100MB)');
      console.log('  log-manager emergency                # Emergency cleanup (24h, 50MB)');
      console.log('  log-manager archive [path]           # Archive all logs to file');
      console.log('  --dry-run                            # Preview changes without executing');
  }
}

if (import.meta.main) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}

export { LogManager };
