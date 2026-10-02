/**
 * How long the local seat's input takes to come back as a stepped frame (2026-10-01): from
 * the moment a changed command is sent to the moment the first frame holding it is stepped.
 * `LocalPredictor` needs this to keep the local player drawn that far ahead of the confirmed
 * sim — without it the prediction can only ease back ONTO the confirmed position, which while
 * moving means carrying the whole latency and, after a stop, sliding on for all of it.
 *
 * Tags are the command's advisory `tick`: the server keeps it (it only restamps `owner`) and
 * `NetInputSource` holds the command object as received, so the frame that applies a command
 * still carries the tag it was sent with. Only CHANGED commands are sent, so a sample comes
 * from each change and a held stick produces none — the last reading stands.
 *
 * The reading is the MINIMUM of the last few samples, not their mean. The server lands every
 * command on the last frame of its 100 ms batch window, so a sample carries up to a batch of
 * phase on top of the real delay. Jitter and phase only ever add, so the floor is the delay.
 */

/** Samples the reading is the floor of. Eight changes is a couple of seconds of play. */
const SAMPLES = 8;
/** Sent tags remembered while waiting to be applied — a bound, not a tuning knob. */
const MAX_PENDING = 64;

export class InputDelayMeter {
  private readonly sentAt = new Map<number, number>();
  private readonly samples: number[] = [];
  private lastApplied: number | null = null;

  /** A changed command left with this tag. A second send under the same tag replaces the
   *  first: the server holds the later one, so the later one is what a frame will apply. */
  sent(tag: number, now: number): void {
    this.sentAt.delete(tag);
    this.sentAt.set(tag, now);
    if (this.sentAt.size > MAX_PENDING) this.sentAt.delete(this.sentAt.keys().next().value!);
  }

  /** A stepped frame applied the local seat's command with this tag. */
  applied(tag: number, now: number): void {
    if (tag === this.lastApplied) return;
    this.lastApplied = tag;
    const at = this.sentAt.get(tag);
    if (at === undefined) return;
    // Everything sent before it was superseded in flight and will never be applied.
    for (const k of this.sentAt.keys()) {
      this.sentAt.delete(k);
      if (k === tag) break;
    }
    this.samples.push(now - at);
    if (this.samples.length > SAMPLES) this.samples.shift();
  }

  /** The delay in ms, or null before the first change has made the round trip. */
  get delayMs(): number | null {
    return this.samples.length > 0 ? Math.min(...this.samples) : null;
  }
}
