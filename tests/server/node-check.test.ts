import { describe, it, expect } from 'vitest';
import { nodeSecurityProblem, assertSafeNode } from '../../server/node-check';

describe('Node.js runtime check (CVE-2026-111497, HTTP2Shell)', () => {
  it('accepts the patched releases and newer ones on each line', () => {
    for (const v of ['v22.23.4', 'v22.24.0', 'v24.22.1', 'v24.30.2', 'v26.12.1', 'v26.13.0', 'v27.0.0', 'v28.1.0']) expect(nodeSecurityProblem(v), v).toBeNull();
  });

  it('refuses unpatched releases with the fixed version named', () => {
    expect(nodeSecurityProblem('v22.22.1')).toMatch(/22\.23\.4/);
    expect(nodeSecurityProblem('v22.23.3')).toMatch(/vulnerable/);
    expect(nodeSecurityProblem('v24.22.0')).toMatch(/24\.22\.1/);
    expect(nodeSecurityProblem('v26.12.0')).toMatch(/26\.12\.1/);
  });

  it('refuses end-of-life lines without a fix', () => {
    for (const v of ['v20.19.0', 'v21.7.3', 'v23.11.0', 'v25.9.0', 'v18.20.4']) expect(nodeSecurityProblem(v), v).toMatch(/end-of-life/);
  });

  it('throws at startup unless explicitly allowed, then only warns', () => {
    expect(() => assertSafeNode('v22.22.1', {})).toThrow(/ANYWORLD_ALLOW_UNPATCHED_NODE/);
    const warnings: string[] = [];
    expect(() => assertSafeNode('v22.22.1', { ANYWORLD_ALLOW_UNPATCHED_NODE: '1' }, (l) => warnings.push(l))).not.toThrow();
    expect(warnings[0]).toMatch(/WARNING/);
    expect(() => assertSafeNode('v22.23.4', {})).not.toThrow();
  });

  it('the running test runtime itself is patched', () => {
    expect(nodeSecurityProblem(process.version)).toBeNull();
  });
});
