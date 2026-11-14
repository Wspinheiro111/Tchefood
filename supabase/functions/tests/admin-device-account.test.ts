import { describe, expect, it } from 'vitest';
import { handleDeviceAccount, randomPasswordFrom, type AuthUser, type DeviceAccountDeps, type RpcResult } from '../admin-device-account/handler.ts';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '33333333-3333-4333-8333-333333333333';
const EMAIL = 'loja-11444777000161@aparelho.tchefood.com.br';
const USER2 = '44444444-4444-4444-8444-444444444444';

interface Fake {
  deps: DeviceAccountDeps;
  calls: string[];
  users: Map<string, AuthUser & { password?: string }>;
  db: FakeDb;
}

/** Estado da assinatura no banco, compartilhável entre duas chamadas ao mesmo tempo. */
interface FakeDb {
  deviceStatus: 'PENDING' | 'READY' | null;
  reservation: { user_id: string; email: string };
  opId: string | null;
}

function fake(opts: {
  deviceStatus?: 'PENDING' | 'READY' | null; storeError?: RpcResult['error']; subscription?: boolean; confirmError?: boolean; createError?: string;
  db?: FakeDb; users?: Map<string, AuthUser & { password?: string }>; beforeAuthWrite?: () => Promise<void>;
} = {}): Fake {
  const calls: string[] = [];
  const users = opts.users ?? new Map<string, AuthUser & { password?: string }>();
  const db: FakeDb = opts.db ?? { deviceStatus: opts.deviceStatus ?? null, reservation: { user_id: USER, email: EMAIL }, opId: null };
  let ops = 0;
  let passwords = 0;
  const deps: DeviceAccountDeps = {
    rpc: async (fn, args) => {
      calls.push(`${fn} ${JSON.stringify(args)}`);
      if (fn === 'tchefood_admin_store') {
        if (opts.storeError) return { data: null, error: opts.storeError };
        return { data: { cnpj: '11444777000161', subscription: opts.subscription === false ? null : { device_status: db.deviceStatus } }, error: null };
      }
      if (fn === 'tchefood_admin_device_lock') {
        if (db.opId !== null && db.opId !== args.p_op) return { data: null, error: { message: 'TCHEFOOD_ADMIN: outra operação na conta do aparelho desta loja está em andamento', code: '55P03' } };
        db.opId = String(args.p_op);
        return { data: '', error: null };
      }
      if (fn === 'tchefood_admin_device_unlock') {
        if (db.opId === args.p_op) db.opId = null;
        return { data: '', error: null };
      }
      if (fn === 'tchefood_admin_reserve_device') {
        if (args.p_replace_user_id) {
          if (args.p_replace_user_id !== db.reservation.user_id || db.deviceStatus !== 'PENDING') return { data: null, error: { message: 'TCHEFOOD_ADMIN: a reserva da conta do aparelho mudou' } };
          db.reservation = { user_id: USER2, email: String(args.p_email) };
        }
        db.deviceStatus ??= 'PENDING';
        return { data: { ...db.reservation, status: db.deviceStatus }, error: null };
      }
      if (fn === 'tchefood_admin_confirm_device') {
        if (opts.confirmError) return { data: null, error: { message: 'x' } };
        if (db.opId !== args.p_op) return { data: null, error: { message: 'TCHEFOOD_ADMIN: outra operação assumiu a conta do aparelho', code: '55P03' } };
        db.deviceStatus = 'READY';
        db.opId = null;
        return { data: '', error: null };
      }
      throw new Error(fn);
    },
    auth: {
      getUserById: async (id) => {
        calls.push(`getUserById ${id}`);
        const u = users.get(id);
        return u ? { user: u, error: null } : { user: null, error: { message: 'User not found', status: 404 } };
      },
      createUser: async (a) => {
        await opts.beforeAuthWrite?.();
        calls.push(`createUser ${a.id} ${a.email} ${JSON.stringify(a.app_metadata)} ${a.email_confirm}`);
        if (opts.createError) return { error: { message: opts.createError } };
        users.set(a.id, { id: a.id, email: a.email, app_metadata: a.app_metadata, password: a.password });
        return { error: null };
      },
      updateUserById: async (id, a) => {
        await opts.beforeAuthWrite?.();
        calls.push(`updateUserById ${id} ${JSON.stringify(a.app_metadata)}`);
        const u = users.get(id)!;
        users.set(id, { ...u, app_metadata: a.app_metadata, password: a.password });
        return { error: null };
      },
    },
    randomPassword: () => (passwords++ === 0 ? 'SenhaForte123456789x' : `SenhaOutra${passwords}`.padEnd(20, 'z')),
    newOpId: () => `op-${++ops}-${Math.random().toString(36).slice(2)}`,
  };
  return { deps, calls, users, db };
}

describe('admin-device-account', () => {
  it('cria a conta com o id e o e-mail reservados, tenant_id no app_metadata, e confirma', async () => {
    const f = fake();
    const r = await handleDeviceAccount({ tenant_id: TENANT, action: 'create' }, f.deps);
    expect(r).toEqual({ status: 200, body: { user_id: USER, email: EMAIL, password: 'SenhaForte123456789x' } });
    expect(f.calls).toEqual([
      `tchefood_admin_store {"p_tenant":"${TENANT}"}`,
      expect.stringMatching(/^tchefood_admin_device_lock /),
      `tchefood_admin_reserve_device {"p_tenant":"${TENANT}","p_email":"${EMAIL}"}`,
      `getUserById ${USER}`,
      `createUser ${USER} ${EMAIL} {"tenant_id":"${TENANT}"} true`,
      expect.stringMatching(new RegExp(`^tchefood_admin_confirm_device \\{"p_tenant":"${TENANT}","p_user_id":"${USER}","p_action":"CREATED","p_op":"op-1-`)),
    ]);
    expect(f.db).toMatchObject({ deviceStatus: 'READY', opId: null });
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
    // Conta pronta apagada à mão no Auth: recria com o mesmo id e e-mail da reserva.
    const gone = fake({ deviceStatus: 'READY' });
    const rg = await handleDeviceAccount({ tenant_id: TENANT, action: 'reset_password' }, gone.deps);
    expect(rg.status).toBe(200);
    expect(gone.calls.some((c) => c.startsWith(`createUser ${USER} ${EMAIL} {"tenant_id":"${TENANT}"}`))).toBe(true);
    expect(gone.users.get(USER)!.password).toBe(rg.body.password);
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
  it('e-mail já usado no Auth: com outro e-mail, a reserva pendente é trocada e a conta sai com o id novo', async () => {
    const f = fake({ deviceStatus: 'PENDING' });
    const r = await handleDeviceAccount({ tenant_id: TENANT, action: 'create', email: 'Flip@Loja.com' }, f.deps);
    expect(r).toMatchObject({ status: 200, body: { user_id: USER2, email: 'flip@loja.com' } });
    expect(f.calls).toContain(`tchefood_admin_reserve_device {"p_tenant":"${TENANT}","p_email":"flip@loja.com","p_replace_user_id":"${USER}"}`);
    expect(f.calls.some((c) => c.startsWith(`createUser ${USER2} flip@loja.com`))).toBe(true);
  });

  it('reserva pendente cuja conta já existe no Auth não é trocada, mesmo com outro e-mail', async () => {
    const f = fake({ deviceStatus: 'PENDING' });
    f.users.set(USER, { id: USER, email: EMAIL, app_metadata: { tenant_id: TENANT } });
    const r = await handleDeviceAccount({ tenant_id: TENANT, action: 'create', email: 'outro@loja.com' }, f.deps);
    expect(r).toMatchObject({ status: 200, body: { user_id: USER, email: EMAIL } });
    expect(f.calls.some((c) => c.includes('p_replace_user_id'))).toBe(false);
  });

  it('duas trocas de senha ao mesmo tempo: uma só responde com senha, e é a que vale no Auth', async () => {
    const db: FakeDb = { deviceStatus: 'READY', reservation: { user_id: USER, email: EMAIL }, opId: null };
    const users = new Map<string, AuthUser & { password?: string }>([[USER, { id: USER, email: EMAIL, app_metadata: { tenant_id: TENANT } }]]);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const a = fake({ db, users, beforeAuthWrite: () => gate });
    const b = fake({ db, users, beforeAuthWrite: () => gate });
    b.deps.randomPassword = () => 'SenhaDoSegundoAdmin1';
    const pa = handleDeviceAccount({ tenant_id: TENANT, action: 'reset_password' }, a.deps);
    const pb = handleDeviceAccount({ tenant_id: TENANT, action: 'reset_password' }, b.deps);
    await new Promise((r) => setTimeout(r, 0));
    release();
    const results = await Promise.all([pa, pb]);
    const ok = results.filter((r) => r.status === 200);
    expect(ok).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(1);
    expect(users.get(USER)!.password).toBe(ok[0].body.password);
    expect(db.opId).toBeNull();
  });

  it('falha no meio devolve a vez: a próxima tentativa não fica travada', async () => {
    const f = fake({ createError: 'boom' });
    expect((await handleDeviceAccount({ tenant_id: TENANT, action: 'create' }, f.deps)).status).toBe(502);
    expect(f.db.opId).toBeNull();
    expect(f.calls.at(-1)).toMatch(/^tchefood_admin_device_unlock /);
  });

  it('outra operação terminou antes da vez: "criar" não troca a senha de conta que ficou pronta', async () => {
    const f = fake({ deviceStatus: 'PENDING' });
    f.users.set(USER, { id: USER, email: EMAIL, app_metadata: { tenant_id: TENANT } });
    const rpc = f.deps.rpc;
    f.deps.rpc = async (fn, args) => {
      const r = await rpc(fn, args);
      if (fn === 'tchefood_admin_store') f.db.deviceStatus = 'READY'; // a outra confirmou entre o passo 1 e a vez
      return r;
    };
    const r = await handleDeviceAccount({ tenant_id: TENANT, action: 'create' }, f.deps);
    expect(r.status).toBe(409);
    expect(f.calls.some((c) => c.startsWith('updateUserById'))).toBe(false);
    expect(f.db.opId).toBeNull();
  });

  it('criação anterior que caiu já criou a conta: "e-mail já usado" do Auth não engana, troca a senha da nossa conta', async () => {
    const f = fake({ deviceStatus: 'PENDING' });
    let first = true;
    const get = f.deps.auth.getUserById;
    f.deps.auth.getUserById = async (id) => {
      if (first) { first = false; return { user: null, error: { message: 'User not found', status: 404 } }; }
      return get(id);
    };
    f.users.set(USER, { id: USER, email: EMAIL, app_metadata: { tenant_id: TENANT } });
    f.deps.auth.createUser = async () => ({ error: { message: 'A user with this email address has already been registered' } });
    const r = await handleDeviceAccount({ tenant_id: TENANT, action: 'create' }, f.deps);
    expect(r.status).toBe(200);
    expect(f.users.get(USER)!.password).toBe(r.body.password);
  });

  it('token vencido no PostgREST vira 401 e e-mail de outra loja vira 409', async () => {
    expect((await handleDeviceAccount({ tenant_id: TENANT, action: 'create' }, fake({ storeError: { message: 'JWT expired', code: 'PGRST301' } }).deps)).status).toBe(401);
    const f = fake();
    const rpc = f.deps.rpc;
    f.deps.rpc = async (fn, args) => (fn === 'tchefood_admin_reserve_device' ? { data: null, error: { message: 'TCHEFOOD_ADMIN: este e-mail já é de outra loja' } } : rpc(fn, args));
    expect((await handleDeviceAccount({ tenant_id: TENANT, action: 'create' }, f.deps)).status).toBe(409);
    expect(f.db.opId).toBeNull();
  });
});
