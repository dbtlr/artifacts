// An ArtifactMetadataStore rejects a create with this error when it cannot
// tell whether the row was stored, for example when an insert failed on the
// way back and the check for its row failed too. The service keeps the
// artifact's content on this error: content without a row is invisible,
// while a row without content fails every read of the artifact.
export class CreateOutcomeUnknownError extends Error {
  constructor(id: string, cause: unknown) {
    super(`Artifact ${JSON.stringify(id)} may or may not have been stored`, { cause });
    this.name = 'CreateOutcomeUnknownError';
  }
}
