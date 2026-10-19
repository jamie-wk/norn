import { Service } from '@norn/activity';

@Service()
export class Clock {
  now() {
    return 0;
  }
}

@Service()
export class Scheduler {
  constructor(
    private readonly clock: Clock,
    _db,
  ) {}
}
