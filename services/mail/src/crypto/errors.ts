/** The passphrase did not open the private key (wrong password, or a corrupted key blob). */
export class WrongPassphraseError extends Error {
  constructor(message = "Wrong passphrase for this private key") {
    super(message);
    this.name = "WrongPassphraseError";
  }
}

/** Ciphertext could not be opened with the given keys, or failed its integrity check. */
export class DecryptionError extends Error {
  constructor(message = "Could not decrypt: no matching key, or the data was modified") {
    super(message);
    this.name = "DecryptionError";
  }
}
