export class CProtocolError extends Error {
  constructor(
    message: string,
    readonly code = "invalid-packet",
  ) {
    super(message);
    this.name = "CProtocolError";
  }
}

export class CUnsupportedOperation extends Error {
  constructor(
    readonly feature: string,
    readonly evidence: string,
  ) {
    super(`Unported or unavailable: ${feature} (${evidence})`);
    this.name = "CUnsupportedOperation";
  }
}
