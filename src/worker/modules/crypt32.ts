import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../core/logger";
import { Mem } from "../core/memory/mem-accessor";
import { System } from "../core/system";

/** CRYPT_E_NOT_FOUND — "Cannot find object or property." The documented result of a
 *  lookup or verify against a store that holds nothing, which is our situation: there
 *  is no certificate infrastructure behind this module. */
const CRYPT_E_NOT_FOUND = 0x80092004;
/** CRYPT_E_ASN1_BADTAG — what the ASN.1 decoder returns for an encoding it can't parse. */
const CRYPT_E_ASN1_BADTAG = 0x8009310b;

export class Crypt32 implements IModule {
    name = "crypt32";
    exports: Record<string, ThunkImplementation> = {};

    initialize(process: Process): void {
        // BOOL CertFreeCertificateContext(PCCERT_CONTEXT pCertContext)
        this.exports["CertFreeCertificateContext"] = (ctx, mem, args) => {
            return { value: 1, stackCleanup: 4 }; // TRUE
        };

        // PCCERT_CONTEXT CertCreateCertificateContext(DWORD dwCertEncodingType,
        //   const BYTE *pbCertEncoded, DWORD cbCertEncoded)
        this.exports["CertCreateCertificateContext"] = (ctx, mem, args) => {
            Logger.verbose(
                LogCategory.SYSTEM,
                `crypt32:CertCreateCertificateContext(enc=0x${(args[0] >>> 0).toString(16)}, cb=${args[2] >>> 0}) -> NULL`
            );
            this.setLastError(CRYPT_E_ASN1_BADTAG);
            return { value: 0, stackCleanup: 12 }; // NULL — no ASN.1 decoder
        };

        // PCCERT_CONTEXT CertFindCertificateInStore(HCERTSTORE hCertStore, DWORD dwCertEncodingType,
        //   DWORD dwFindFlags, DWORD dwFindType, const void *pvFindPara, PCCERT_CONTEXT pPrevCertContext)
        this.exports["CertFindCertificateInStore"] = (ctx, mem, args) => {
            this.setLastError(CRYPT_E_NOT_FOUND);
            return { value: 0, stackCleanup: 24 }; // NULL — not found
        };

        // BOOL CertVerifySubjectCertificateContext(PCCERT_CONTEXT pSubject,
        //   PCCERT_CONTEXT pIssuer, DWORD *pdwFlags)
        //
        // pdwFlags is in/out: on entry the checks to perform, on return the bits still
        // set are the checks that FAILED. With no issuer chain to check against every
        // requested check fails — so leave the caller's bits alone and report that the
        // verification itself ran (TRUE).
        this.exports["CertVerifySubjectCertificateContext"] = (ctx, mem, args) => {
            const pdwFlags = args[2] >>> 0;
            if (pdwFlags) {
                Logger.verbose(
                    LogCategory.SYSTEM,
                    `crypt32:CertVerifySubjectCertificateContext flags=0x${(Mem.readUint32(pdwFlags) ?? 0).toString(16)} (all checks fail)`
                );
            }
            return { value: 1, stackCleanup: 12 }; // TRUE — checks ran, failures in *pdwFlags
        };

        // BOOL CryptMsgGetParam(HCRYPTMSG hCryptMsg, DWORD dwParamType, DWORD dwIndex,
        //   void *pvData, DWORD *pcbData)
        this.exports["CryptMsgGetParam"] = (ctx, mem, args) => {
            return { value: 0, stackCleanup: 20 }; // FALSE
        };

        // BOOL CryptQueryObject(DWORD dwObjectType, const void *pvObject, DWORD dwExpectedContentTypeFlags,
        //   DWORD dwExpectedFormatTypeFlags, DWORD dwFlags, DWORD *pdwMsgAndCertEncodingType,
        //   DWORD *pdwContentType, DWORD *pdwFormatType, HCERTSTORE *phCertStore,
        //   HCRYPTMSG *phMsg, const void **ppvContext)
        this.exports["CryptQueryObject"] = (ctx, mem, args) => {
            return { value: 0, stackCleanup: 44 }; // FALSE
        };

        // BOOL CertCloseStore(HCERTSTORE hCertStore, DWORD dwFlags)
        this.exports["CertCloseStore"] = (ctx, mem, args) => {
            return { value: 1, stackCleanup: 8 }; // TRUE
        };

        // BOOL CryptMsgClose(HCRYPTMSG hCryptMsg)
        this.exports["CryptMsgClose"] = (ctx, mem, args) => {
            return { value: 1, stackCleanup: 4 }; // TRUE
        };

        // HCERTSTORE CryptGetMessageCertificates(DWORD dwMsgAndCertEncodingType,
        //   HCRYPTPROV_LEGACY hCryptProv, DWORD dwFlags, const BYTE *pbSignedBlob,
        //   DWORD cbSignedBlob)
        this.exports["CryptGetMessageCertificates"] = (ctx, mem, args) => {
            Logger.verbose(
                LogCategory.SYSTEM,
                `crypt32:CryptGetMessageCertificates(cb=${args[4] >>> 0}) -> NULL`
            );
            this.setLastError(CRYPT_E_NOT_FOUND);
            return { value: 0, stackCleanup: 20 }; // NULL — no store to open
        };

        // BOOL CryptVerifyMessageSignature(PCRYPT_VERIFY_MESSAGE_PARA pVerifyPara,
        //   DWORD dwSignerIndex, const BYTE *pbSignedBlob, DWORD cbSignedBlob,
        //   BYTE *pbDecoded, DWORD *pcbDecoded, PCCERT_CONTEXT *ppSignerCert)
        //
        // Failure still has to leave the out-params well defined: callers read *pcbDecoded
        // and *ppSignerCert (and free the latter) whatever the return value.
        this.exports["CryptVerifyMessageSignature"] = (ctx, mem, args) => {
            const pcbDecoded = args[5] >>> 0;
            const ppSignerCert = args[6] >>> 0;
            if (pcbDecoded) Mem.writeUint32(pcbDecoded, 0);
            if (ppSignerCert) Mem.writeUint32(ppSignerCert, 0);
            Logger.verbose(
                LogCategory.SYSTEM,
                `crypt32:CryptVerifyMessageSignature(signer=${args[1] >>> 0}, cb=${args[3] >>> 0}) -> FALSE`
            );
            this.setLastError(CRYPT_E_NOT_FOUND);
            return { value: 0, stackCleanup: 28 }; // FALSE — nothing to verify against
        };

        // DWORD CertGetNameStringA(PCCERT_CONTEXT pCertContext, DWORD dwType, DWORD dwFlags,
        //   void *pvTypePara, LPSTR pszNameString, DWORD cchNameString)
        const certGetNameString = (ctx: any, mem: Uint8Array, args: number[]) => {
            const pszNameString = args[4] >>> 0;
            const cchNameString = args[5] >>> 0;
            // Write empty string if buffer provided
            if (pszNameString && cchNameString > 0) {
                mem[pszNameString] = 0;
            }
            return { value: 1, stackCleanup: 24 }; // 1 char written (null terminator)
        };

        this.exports["CertGetNameStringA"] = certGetNameString;
        this.exports["CertGetNameStringW"] = certGetNameString;
        this.exports["CertGetNameString"] = certGetNameString;
    }

    private setLastError(code: number): void {
        System.getInstance().scheduler.setLastError(code);
    }
}
