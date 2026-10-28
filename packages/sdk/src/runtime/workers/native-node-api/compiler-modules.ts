import { decodeRuntimeBase64 } from "../../base64.js";

declare const NATIVE_COMPILER_WASM_BASE64: string;
declare const NATIVE_HTTP_PARSER_BASE64: string;

const compile = (source: string) => WebAssembly.compile(decodeRuntimeBase64(source));
export const modules = Promise.all([compile(NATIVE_COMPILER_WASM_BASE64), compile(NATIVE_HTTP_PARSER_BASE64)]);
