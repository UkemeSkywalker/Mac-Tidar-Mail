import { enums, type PartialConfig } from "openpgp";

/** Argon2id cost parameters (RFC 9106 notation; memory is 2^memoryExponent KiB). */
export interface KdfParams {
  passes: number;
  parallelism: number;
  memoryExponent: number;
}

/** RFC 9106 "second recommended option": t=3, p=4, m=64 MiB. Safe on phones. */
export const DEFAULT_KDF: Readonly<KdfParams> = Object.freeze({ passes: 3, parallelism: 4, memoryExponent: 16 });

/**
 * Upper bound on Argon2 memory we will ever allocate (2^20 KiB = 1 GiB), on lock and unlock.
 * A tampered key blob from the server must not be able to make the browser allocate more.
 */
export const MAX_KDF_MEMORY_EXPONENT = 20;

/** Config for reading or unlocking anything that may carry Argon2 S2K. */
export const readConfig: PartialConfig = { maxArgon2MemoryExponent: MAX_KDF_MEMORY_EXPONENT };

/** Config for encrypting a private key: Argon2 S2K, which OpenPGP only allows with AEAD key protection. */
export function keyLockConfig(kdf: KdfParams): PartialConfig {
  if (kdf.memoryExponent > MAX_KDF_MEMORY_EXPONENT) {
    throw new RangeError(`Argon2 memory exponent ${kdf.memoryExponent} exceeds the cap of ${MAX_KDF_MEMORY_EXPONENT}`);
  }
  return {
    ...readConfig,
    s2kType: enums.s2k.argon2,
    s2kArgon2Params: { ...kdf },
    aeadProtect: true,
  };
}
