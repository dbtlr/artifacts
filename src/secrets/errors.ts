export type SecretInputField = 'content' | 'filename' | 'label' | 'ttlSeconds';

// The input to a secret create or upload breaks a limit. `field` names the
// input, so the HTTP and MCP layers can report it; the message never quotes
// the content.
export class InvalidSecretInputError extends Error {
  readonly field: SecretInputField;

  constructor(field: SecretInputField, message: string) {
    super(message);
    this.name = 'InvalidSecretInputError';
    this.field = field;
  }
}

// The store already holds as many live secrets and upload slots as it may.
export class SecretLimitError extends Error {
  constructor(limit: number) {
    super(`At most ${String(limit)} unread secrets and upload slots may exist at once`);
    this.name = 'SecretLimitError';
  }
}
