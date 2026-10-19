import { Query, Signal } from '@norn-ts/workflow';

/** Pause/resume handlers shared by several workflows. */
export class Pausable {
  protected paused = false;

  /** Pause processing. */
  @Signal() pause() {
    this.paused = true;
  }

  @Signal() resume() {
    this.paused = false;
  }

  @Query() isPaused() {
    return this.paused;
  }
}
