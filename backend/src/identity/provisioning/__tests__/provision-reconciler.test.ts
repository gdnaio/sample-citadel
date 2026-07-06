import { createProvisionReconciler, ReconcilerDeps } from '../provision-reconciler';

function deps(provisionImpl: ReconcilerDeps['provisioning']['provision']): ReconcilerDeps {
  return { provisioning: { provision: provisionImpl } };
}

const input = {
  sub: 'sub-1',
  email: 'a@b.com',
  orgId: 'org-1',
  intendedGroup: 'architect' as const,
  correlationId: 'corr-1',
};

describe('provision reconciler', () => {
  it('recovers a previously-failed provisioning', async () => {
    const reconcile = createProvisionReconciler(
      deps(async (i) => ({ user: { ...i } as never, created: true })),
    );
    await expect(reconcile(input)).resolves.toEqual({ recovered: true });
  });

  it('is idempotent when the user already exists', async () => {
    const reconcile = createProvisionReconciler(
      deps(async (i) => ({ user: { ...i } as never, created: false })),
    );
    await expect(reconcile(input)).resolves.toEqual({ recovered: false });
  });

  it('propagates errors so the event source can retry / dead-letter', async () => {
    const reconcile = createProvisionReconciler(
      deps(async () => {
        throw new Error('still down');
      }),
    );
    await expect(reconcile(input)).rejects.toThrow('still down');
  });

  it('passes the intended group through to provisioning', async () => {
    const calls: unknown[] = [];
    const reconcile = createProvisionReconciler(
      deps(async (i) => {
        calls.push(i);
        return { user: { ...i } as never, created: true };
      }),
    );
    await reconcile(input);
    expect(calls[0]).toMatchObject({ sub: 'sub-1', platformGroup: 'architect' });
  });
});
