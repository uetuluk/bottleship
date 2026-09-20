import { ModuleDescriptor, FunctionDescriptor, ParameterDescriptor } from "./types";

const buildParams = (count: number): ParameterDescriptor[] => {
    const params: ParameterDescriptor[] = [];
    for (let i = 0; i < count; i++) {
        params.push({ name: `arg${i}`, type: "u32" });
    }
    return params;
};

const makeFunc = (name: string, argCount: number, overrides: Partial<FunctionDescriptor> = {}): FunctionDescriptor => ({
    name,
    params: overrides.params ?? buildParams(argCount),
    returnType: overrides.returnType ?? "u32",
    callingConvention: overrides.callingConvention ?? "stdcall",
});

export const crypt32Module: ModuleDescriptor = {
    name: "crypt32",
    functions: [
        makeFunc("CertFreeCertificateContext", 1),
        makeFunc("CertCreateCertificateContext", 3),
        makeFunc("CertFindCertificateInStore", 6),
        makeFunc("CertVerifySubjectCertificateContext", 3),
        makeFunc("CryptMsgGetParam", 5),
        makeFunc("CryptQueryObject", 11),
        makeFunc("CertCloseStore", 2),
        makeFunc("CryptMsgClose", 1),
        makeFunc("CryptGetMessageCertificates", 5),
        makeFunc("CryptVerifyMessageSignature", 7),
        makeFunc("CertGetNameStringA", 6),
        makeFunc("CertGetNameStringW", 6),
        makeFunc("CertGetNameString", 6),
    ],
};
