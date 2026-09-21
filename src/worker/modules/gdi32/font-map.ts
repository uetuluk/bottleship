/**
 * Windows face name → the family GDI text rendering actually draws with.
 *
 * A face the GUEST installed always wins: when a game ships its own TTFs and the
 * installer put them in the Windows font directory, that file IS the face the
 * game means, and substituting for it renders the UI in the wrong typeface.
 * Only when no such face is registered do we fall back to the metric-compatible
 * Liberation fonts we ship for the standard Windows set.
 */

import { isFontFamilyRegistered } from "./font-registry";

const WINDOWS_FONT_MAP: Readonly<Record<string, string>> = {
    'arial':                'Liberation Sans',
    'helvetica':            'Liberation Sans',
    'ms sans serif':        'Liberation Sans',
    'microsoft sans serif': 'Liberation Sans',
    'tahoma':               'Liberation Sans',
    'verdana':              'Liberation Sans',
    'courier new':          'Liberation Mono',
    'courier':              'Liberation Mono',
    'times new roman':      'Liberation Serif',
    'times':                'Liberation Serif',
    'comic sans ms':        'Liberation Sans',
    'impact':               'Liberation Sans',
};

/** Map a requested Windows face name to a family the canvas can resolve. */
export function resolveWindowsFontName(faceName: string): string {
    if (!faceName) return 'Liberation Sans';
    if (isFontFamilyRegistered(faceName)) return faceName;
    const mapped = WINDOWS_FONT_MAP[faceName.toLowerCase()];
    return mapped ?? faceName;
}
