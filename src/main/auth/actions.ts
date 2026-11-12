// Pairing commands retain their original window and server while another
// command is running. Local unpairing is not gated on a remote page load, and
// a queued removal still runs when an earlier pairing fails or is cancelled.

export class PairingActions<T> {
  private tail: Promise<void> = Promise.resolve();
  private readonly run: (request: T) => Promise<void>;
  constructor(run: (request: T) => Promise<void>) { this.run = run; }

  submit(request: T): Promise<void> {
    const work = this.tail.then(() => this.run(request));
    this.tail = work.catch(() => {});
    return work;
  }
}
