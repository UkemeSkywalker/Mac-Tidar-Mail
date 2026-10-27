// The browser shares the exact OpenPGP formats the Lambdas use. Every openpgp
// call goes through this one module so only a single copy of the library is
// bundled and key objects are always from the same instance.
export * from "../../../services/mail/src/crypto";
