import { describe, expect, it } from 'vitest';
import { classTag, methodTags, setClassTag, tagMethod } from '../src/meta.ts';

const HANDLER = Symbol.for('norn.test.handler');
const CLS = Symbol.for('norn.test.class');

function Handler(name?: string) {
  return (fn: Function, ctx: ClassMethodDecoratorContext) => {
    tagMethod(fn, HANDLER, { name: name ?? String(ctx.name) });
  };
}

function Marked(value: string) {
  return (cls: Function, _ctx: ClassDecoratorContext) => {
    setClassTag(cls, CLS, value);
  };
}

class Base {
  @Handler() pause() {}
  @Handler() resume() {}
  plain() {}
}

@Marked('child')
class Child extends Base {
  @Handler('go') start() {}
  // Overrides keep the inherited handler declaration and call the subclass implementation.
  override resume() {}
}

describe('method tags', () => {
  it('collects tagged methods across the prototype chain, most-derived first', () => {
    const tags = methodTags<{ name: string }>(Child, HANDLER);
    expect(tags.map((t) => [t.method, t.tag.name])).toEqual([
      ['start', 'go'],
      ['pause', 'pause'],
      ['resume', 'resume'],
    ]);
  });

  it('ignores untagged methods', () => {
    expect(methodTags(Base, HANDLER).map((t) => t.method)).not.toContain('plain');
  });

  it('reads class tags without leaking to the parent', () => {
    expect(classTag(Child, CLS)).toBe('child');
    expect(classTag(Base, CLS)).toBeUndefined();
  });

  it('refuses to tag the same function twice with the same key', () => {
    const fn = () => {};
    tagMethod(fn, HANDLER, { name: 'a' });
    expect(() => tagMethod(fn, HANDLER, { name: 'b' })).toThrow(/already/);
  });
});
