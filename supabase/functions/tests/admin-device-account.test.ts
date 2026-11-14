import { describe, expect, it } from 'vitest';
import { handleDeviceAccount, randomPasswordFrom, type AuthUser, type DeviceAccountDeps, type RpcResult } from '../admin-device-account/handler.ts';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '33333333-3333-4333-8333-333333333333';
const EMAIL = 'loja-11444777000161@aparelho.tchefood.com.br';

interface Fake {
  deps: DeviceAccountDeps;
  calls: string[];
  users: Map<string, AuthUser & { password?: string }>;
}

function fake(opts: { deviceStatus?: 'PENDING' | 'READY' | null; storeError?: RpcResult['error']; subscription?: boolean; confirmError?: boolean; createError?: string } = {}): Fake {
  const calls: string[] = [];
  const users = new Map<string, AuthUser & { password?: string }>();
  const deps: DeviceAccountDeps = {
    rpc: async (fn, args) => {
      calls.push(`${fn} ${JSON.stringify(args)}`);
      if (fn === 'tchefood_admin_store') {
        if (opts.storeError) return { data: null, error: opts.storeError };
        return { data: { cnpj: '11444777000161', subscription: opts.subscription === false ? null : { device_status: opts.deviceStatus ?? null } }, error: null };
      }
      if (fn === 'tchefood_admin_reserve_device') return { data: { user_id: USER, email: EMAIL, status: 'PENDING' }, error: null };
      if (fn === 'tchefood_admin_confirm_device') return opts.confirmError ? { data: null, error: { message: 'x' } } : { data: '', error: null };
      throw new Error(fn);
    },
    auth: {
      getUserById: async (id) => {
        calls.push(`getUserById ${id}`);
        const u = users.get(id);
        return u ? { user: u, error: null } : { user: null, error: { message: 'User not found', status: 404 } };
      },
      createUser: async (a) => {
        calls.push(`createUser ${a.id} ${a.email} ${JSON.stringify(a.app_metadata)} ${a.email_confirm}`);
        if (opts.createError) return { error: { message: opts.createError } };
        users.set(a.id, { id: a.id, email: a.email, app_metadata: a.app_metadata, password: a.password });
        return { error: null };
      },
      updateUserById: async (id, a) => {
        calls.push(`updateUserById ${id} ${JSON.stringify(a.app_metadata)}`);
        const u = users.get(id)!;
        users.set(id, { ...u, app_metadata: a.app_metadata, password: a.password });
        return { error: null };
      },
    },
    randomPassword: () => 'SenhaForte123456789x',
  };
  return { deps, calls, users };
}

describe('admin-device-account', () => {
  it('cria a conta com o id e o e-mail reservados, tenant_id no app_metadata, e confirma', async () => {
    const f = fake();
    const r = await handleDeviceAccount({ tenant_id: TENANT, action: 'create' }, f.deps);
    expect(r).toEqual({ status: 200, body: { user_id: USER, email: EMAIL, password: 'SenhaForte123456789x' } });
    expect(f.calls).toEqual([
      `tchefood_admin_store {"p_tenant":"${TENANT}"}`,
      `tchefood_admin_reserve_device {"p_tenant":"${TENANT}","p_email":"${EMAIL}"}`,
      `getUserById ${USER}`,
      `createUser ${USER} ${EMAIL} {"tenant_id":"${TENANT}"} true`,
      `tchefood_admin_confirm_device {"p_tenant":"${TENANT}","p_user_id":"${USER}","p_action":"CREATED"}`,
    ]);
  });

  it('quem não é admin (ou token de loja) não chega no Auth', async () => {
    const f = fake({ storeError: { message: 'TCHEFOOD_ADMIN: acesso restrito à equipe do Tchê Food', code: '42501' } });
    const r = await handleDeviceAccount({ tenant_id: TENANT, action: 'create' }, f.deps);
    expect(r.status).toBe(403);
    expect(r.body.message).toBe('acesso restrito à equipe do Tchê Food');
    expect(f.calls.some((c) => c.startsWith('createUser') || c.startsWith('getUserById'))).toBe(false);
  });

  it('entrada inválida, loja sem assinatura e conta já pronta são recusadas antes do Auth', async () => {
    expect((await handleDeviceAccount({ tenant_id: 'x', action: 'create' }, fake().deps)).status).toBe(400);
    expect((await handleDeviceAccount({ tenant_id: TENANT, action: 'apagar' }, fake().deps)).status).toBe(400);
    expect((await handleDeviceAccount({ tenant_id: TENANT, action: 'create', email: 'sem-arroba' }, fake().deps)).status).toBe(400);
    expect((await handleDeviceAccount({ tenant_id: TENANT, action: 'create' }, fake({ subscription: false }).deps)).status).toBe(409);
    const ready = fake({ deviceStatus: 'READY' });
    expect((await handleDeviceAccount({ tenant_id: TENANT, action: 'create' }, ready.deps)).status).toBe(409);
    expect(ready.calls).toHaveLength(1);
    expect((await handleDeviceAccount({ tenant_id: TENANT, action: 'reset_password' }, fake({ deviceStatus: 'PENDING' }).deps)).status).toBe(409);
  });

  it('retomada depois de cair no meio: a conta reservada já existe, troca a senha e confirma', async () => {
    const f = fake({ deviceStatus: 'PENDING' });
    f.users.set(USER, { id: USER, email: EMAIL, app_metadata: { tenant_id: TENANT } });
    const r = await handleDeviceAccount({ tenant_id: TENANT, action: 'create' }, f.deps);
    expect(r.status).toBe(200);
    expect(f.calls.some((c) => c.startsWith('createUser'))).toBe(false);
    expect(f.users.get(USER)!.password).toBe('SenhaForte123456789x');
  });

  it('não mexe em conta de outra loja ou com outro e-mail', async () => {
    for (const other of [
      { id: USER, email: EMAIL, app_metadata: { tenant_id: '99999999-9999-4999-8999-999999999999' } },
      { id: USER, email: 'will@tchefood.com.br', app_metadata: {} },
    ]) {
      const f = fake({ deviceStatus: 'READY' });
      f.users.set(USER, other);
      const r = await handleDeviceAccount({ tenant_id: TENANT, action: 'reset_password' }, f.deps);
      expect(r.status).toBe(409);
      expect(f.calls.some((c) => c.startsWith('updateUserById'))).toBe(false);
    }
  });

  it('trocar senha: só da conta pronta, confirma como PASSWORD_RESET', async () => {
    const f = fake({ deviceStatus: 'READY' });
    f.users.set(USER, { id: USER, email: EMAIL, app_metadata: { tenant_id: TENANT } });
    const r = await handleDeviceAccount({ tenant_id: TENANT, action: 'reset_password' }, f.deps);
    expect(r.status).toBe(200);
    expect(f.calls.at(-1)).toContain('"p_action":"PASSWORD_RESET"');
    const gone = fake({ deviceStatus: 'READY' });
    expect((await handleDeviceAccount({ tenant_id: TENANT, action: 'reset_password' }, gone.deps)).status).toBe(409);
    expect(gone.calls.some((c) => c.startsWith('createUser'))).toBe(false);
  });

  it('e-mail já usado no Auth e falha ao confirmar viram mensagens claras', async () => {
    const dup = await handleDeviceAccount({ tenant_id: TENANT, action: 'create' }, fake({ createError: 'A user with this email address has already been registered' }).deps);
    expect(dup.status).toBe(409);
    const conf = await handleDeviceAccount({ tenant_id: TENANT, action: 'create' }, fake({ confirmError: true }).deps);
    expect(conf.status).toBe(500);
    expect(conf.body.message).toMatch(/Criar conta/);
    expect(conf.body.password).toBeUndefined();
  });

  it('senha sorteada: 20 caracteres do alfabeto sem letras parecidas, sem viés de módulo', () => {
    let n = 0;
    const pw = randomPasswordFrom((a) => {
      for (let i = 0; i < a.length; i++) a[i] = (n++ * 37) % 256;
      return a;
    });
    expect(pw).toHaveLength(20);
    expect(pw).toMatch(/^[A-HJ-NP-Za-km-z2-9]+$/);
    // Bytes no fim da faixa (>= 224 com 56 letras) são descartados.
    expect(randomPasswordFrom((a) => a.fill(250).map((_, i) => (i % 2 ? 250 : 0)))).toBe('A'.repeat(20));
  });
});
