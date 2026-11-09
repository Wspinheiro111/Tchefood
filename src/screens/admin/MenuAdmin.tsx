/**
 * Etapa 0 — Cardápio na tela: categorias, produtos, adicionais, vínculos,
 * preço por horário e esgotado. Toda regra fica no store; aqui só coletamos.
 */
import { useMemo, useState } from 'react';
import { Clock, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { selectCan, useTcheStore } from '../../store/useTcheStore';
import type { Category, ModifierGroup, ModifierOption, PriceSchedule, Product, ProductionSector } from '../../types';
import { SECTORS, SECTOR_NAME, WEEKDAY_SHORT, activeSchedule } from '../../lib/catalog';
import { formatBRL } from '../../lib/money';
import { Badge, Btn, Sheet, toast } from '../../components/ui';
import { Field, FormError, Panel, Select, TextInput, Toggle, moneyToInput, parseIntInput, parseMoneyInput } from './fields';

type Sub = 'products' | 'categories' | 'modifiers' | 'schedules';

export function MenuAdmin() {
  const canManage = useTcheStore((s) => selectCan(s, 'MENU_MANAGE'));
  const [sub, setSub] = useState<Sub>('products');
  const subs: Array<{ key: Sub; label: string }> = [
    { key: 'products', label: 'Produtos' },
    ...(canManage
      ? ([
          { key: 'categories', label: 'Categorias' },
          { key: 'modifiers', label: 'Adicionais' },
          { key: 'schedules', label: 'Preço por horário' },
        ] as const)
      : []),
  ];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {subs.map((s) => (
          <button key={s.key} onClick={() => setSub(s.key)} className={`min-h-touch rounded-full px-4 text-sm font-bold ${sub === s.key ? 'bg-slate-200 text-slate-950' : 'bg-surface text-slate-700'}`}>
            {s.label}
          </button>
        ))}
      </div>
      {sub === 'products' && <ProductsPanel canManage={canManage} />}
      {sub === 'categories' && canManage && <CategoriesPanel />}
      {sub === 'modifiers' && canManage && <ModifiersPanel />}
      {sub === 'schedules' && canManage && <SchedulesPanel />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PRODUTOS
// ---------------------------------------------------------------------------
function ProductsPanel({ canManage }: { canManage: boolean }) {
  const products = useTcheStore((s) => s.products);
  const categories = useTcheStore((s) => s.categories);
  const schedules = useTcheStore((s) => s.priceSchedules);
  const canAvailability = useTcheStore((s) => selectCan(s, 'MENU_AVAILABILITY'));
  const setAvailable = useTcheStore((s) => s.setProductAvailable);
  const [q, setQ] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<Product | 'new' | null>(null);

  const groups = useMemo(() => {
    const term = q.trim().toLowerCase();
    const sorted = [...categories].sort((a, b) => a.sort_order - b.sort_order);
    return sorted
      .map((c) => ({
        category: c,
        items: products
          .filter((p) => p.category_id === c.id && (showInactive || p.active))
          .filter((p) => !term || p.name.toLowerCase().includes(term) || p.code.toLowerCase().includes(term))
          .sort((a, b) => a.code.localeCompare(b.code, 'pt-BR', { numeric: true })),
      }))
      .filter((g) => g.items.length > 0);
  }, [products, categories, q, showInactive]);

  const now = new Date();
  return (
    <Panel
      title={`Produtos (${products.filter((p) => p.active).length} ativos)`}
      action={canManage && <Btn variant="gold" disabled={categories.length === 0} onClick={() => setEditing('new')}><Plus className="h-4 w-4" /> Novo produto</Btn>}
    >
      {canManage && categories.length === 0 && <p className="mb-3 text-sm text-brasa">Crie uma categoria antes do primeiro produto.</p>}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por nome ou código" className="pl-9" />
        </div>
        {canManage && (
          <button onClick={() => setShowInactive(!showInactive)} className={`min-h-touch rounded-xl px-3 text-sm font-bold ${showInactive ? 'bg-slate-200 text-slate-950' : 'bg-base text-slate-700'}`}>
            {showInactive ? 'Mostrando desativados' : 'Mostrar desativados'}
          </button>
        )}
      </div>
      {groups.length === 0 && <p className="p-4 text-center text-sm text-slate-500">Nenhum produto encontrado.</p>}
      {groups.map((g) => (
        <div key={g.category.id} className="mb-4">
          <div className="mb-1 text-xs font-bold uppercase tracking-wide text-slate-500">{g.category.name}{!g.category.active && ' · categoria desativada'}</div>
          <div className="divide-y divide-slate-200 rounded-xl bg-base">
            {g.items.map((p) => {
              const rule = activeSchedule(p.id, schedules, now);
              return (
                <div key={p.id} className={`flex flex-wrap items-center gap-3 p-3 ${p.active ? '' : 'opacity-50'}`}>
                  <div className="min-w-0 flex-1">
                    <div className="font-bold">
                      <span className="mr-2 font-mono text-xs text-slate-500">{p.code}</span>
                      {p.name}
                      {!p.active && <Badge className="ml-2 bg-neutral-500 text-white">desativado</Badge>}
                      {!p.available && p.active && <Badge className="ml-2 bg-brasa text-white">esgotado</Badge>}
                    </div>
                    <div className="text-xs text-slate-500">
                      {SECTOR_NAME[p.sector]} · {formatBRL(p.price)}
                      {rule && <span className="ml-1 text-brasa"><Clock className="inline h-3 w-3" /> agora {formatBRL(rule.price)} ({rule.name})</span>}
                    </div>
                  </div>
                  {p.active && canAvailability && (
                    <Btn
                      variant={p.available ? 'secondary' : 'success'}
                      onClick={() => {
                        const r = setAvailable(p.id, !p.available);
                        if (!r.ok) toast.error(r.error);
                        else toast.info(`${p.name}: ${r.data.available ? 'voltou ao cardápio' : 'marcado como esgotado'}.`);
                      }}
                    >
                      {p.available ? 'Esgotar' : 'Voltar a vender'}
                    </Btn>
                  )}
                  {canManage && (
                    <Btn variant="ghost" aria-label={`Editar ${p.name}`} onClick={() => setEditing(p)}><Pencil className="h-4 w-4" /></Btn>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
      {editing && <ProductEditor product={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </Panel>
  );
}

interface ProductForm {
  category_id: string;
  code: string;
  name: string;
  description: string;
  price: string;
  sector: ProductionSector;
  available: boolean;
  active: boolean;
  requires_meat_doneness: boolean;
  allows_half_and_half: boolean;
  is_combo: boolean;
  ncm: string;
  cfop: string;
  csosn_cst: string;
  unit: string;
  groupIds: string[];
}

function ProductEditor({ product, onClose }: { product: Product | null; onClose: () => void }) {
  const categories = useTcheStore((s) => s.categories);
  const groups = useTcheStore((s) => s.modifierGroups);
  const links = useTcheStore((s) => s.productModifierGroups);
  const saveProduct = useTcheStore((s) => s.saveProduct);
  const setLinks = useTcheStore((s) => s.setProductModifierGroups);
  const sortedCats = [...categories].sort((a, b) => a.sort_order - b.sort_order);
  const [f, setF] = useState<ProductForm>(() => ({
    category_id: product?.category_id ?? sortedCats.find((c) => c.active)?.id ?? sortedCats[0]?.id ?? '',
    code: product?.code ?? '',
    name: product?.name ?? '',
    description: product?.description ?? '',
    price: product ? moneyToInput(product.price) : '',
    sector: product?.sector ?? 'KITCHEN',
    available: product?.available ?? true,
    active: product?.active ?? true,
    requires_meat_doneness: product?.requires_meat_doneness ?? false,
    allows_half_and_half: product?.allows_half_and_half ?? false,
    is_combo: product?.is_combo ?? false,
    // Sem padrão fiscal: NCM, CFOP e CSOSN vêm da contabilidade da loja.
    ncm: product?.ncm ?? '',
    cfop: product?.cfop ?? '',
    csosn_cst: product?.csosn_cst ?? '',
    unit: product?.unit ?? 'UN',
    groupIds: product
      ? links.filter((l) => l.product_id === product.id).sort((a, b) => a.sort_order - b.sort_order).map((l) => l.group_id)
      : [],
  }));
  const [error, setError] = useState<string | null>(null);
  const up = <K extends keyof ProductForm>(k: K, v: ProductForm[K]) => setF((x) => ({ ...x, [k]: v }));

  const save = () => {
    const price = parseMoneyInput(f.price);
    if (Number.isNaN(price)) return setError('Preço inválido. Use o formato 49,90.');
    const res = saveProduct({
      id: product?.id,
      category_id: f.category_id,
      code: f.code,
      name: f.name,
      description: f.description,
      price,
      sector: f.sector,
      available: f.available,
      active: f.active,
      requires_meat_doneness: f.requires_meat_doneness,
      allows_half_and_half: f.allows_half_and_half,
      is_combo: f.is_combo,
      ncm: f.ncm,
      cfop: f.cfop,
      csosn_cst: f.csosn_cst,
      unit: f.unit,
    });
    if (!res.ok) return setError(res.error);
    const linkRes = setLinks(res.data.id, f.groupIds);
    if (!linkRes.ok) return setError(`Produto salvo, mas os adicionais não: ${linkRes.error}`);
    toast.success(product ? `${res.data.name} atualizado.` : `${res.data.name} criado.`);
    if (product && product.price !== res.data.price) toast.alert('Troca de preço registrada na auditoria. Itens já lançados mantêm o preço antigo.');
    onClose();
  };

  const toggleGroup = (id: string) => up('groupIds', f.groupIds.includes(id) ? f.groupIds.filter((g) => g !== id) : [...f.groupIds, id]);

  return (
    <Sheet open onClose={onClose} wide title={product ? `Editar ${product.name}` : 'Novo produto'} footer={<Btn block size="lg" onClick={save}>Salvar produto</Btn>}>
      <FormError error={error} />
      <div className="grid gap-x-3 sm:grid-cols-2">
        <Field label="Nome"><TextInput value={f.name} maxLength={150} onChange={(e) => up('name', e.target.value)} /></Field>
        <Field label="Código" hint="Usado na busca rápida do garçom. Único na loja."><TextInput value={f.code} maxLength={20} onChange={(e) => up('code', e.target.value)} /></Field>
        <Field label="Categoria">
          <Select value={f.category_id} onChange={(v) => up('category_id', v)} options={sortedCats.map((c) => ({ value: c.id, label: c.active ? c.name : `${c.name} (desativada)` }))} />
        </Field>
        <Field label="Preço (R$)"><TextInput inputMode="decimal" value={f.price} onChange={(e) => up('price', e.target.value)} placeholder="49,90" /></Field>
        <Field label="Setor de produção" hint="Define em qual tela do KDS e impressora o item sai.">
          <Select value={f.sector} onChange={(v) => up('sector', v)} options={SECTORS.map((s) => ({ value: s, label: SECTOR_NAME[s] }))} />
        </Field>
        <Field label="Unidade"><TextInput value={f.unit} maxLength={6} onChange={(e) => up('unit', e.target.value)} /></Field>
      </div>
      <Field label="Descrição (aparece no cardápio QR)">
        <textarea value={f.description} maxLength={500} rows={2} onChange={(e) => up('description', e.target.value)} className="w-full rounded-xl border border-slate-300 bg-base p-3 text-[1rem] text-slate-900 outline-none focus:border-ouro" />
      </Field>
      <div className="grid gap-x-3 sm:grid-cols-2">
        <Toggle label="Disponível (desligado = esgotado)" checked={f.available} onChange={(v) => up('available', v)} />
        <Toggle label="Ativo no cardápio" checked={f.active} onChange={(v) => up('active', v)} />
        <Toggle label="Pergunta ponto da carne" checked={f.requires_meat_doneness} onChange={(v) => up('requires_meat_doneness', v)} />
        <Toggle label="Aceita meio a meio" checked={f.allows_half_and_half} onChange={(v) => up('allows_half_and_half', v)} />
        <Toggle label="É um combo" checked={f.is_combo} onChange={(v) => up('is_combo', v)} />
      </div>
      {f.is_combo && (
        <p className="mb-2 rounded-xl bg-base p-3 text-xs text-slate-500">
          O preço acima é o do combo. Os itens saem dos grupos marcados abaixo: cada opção que aponta para um produto vira um item na praça dele (KDS e impressora), sem valor próprio. Grupo obrigatório com uma opção só é item fixo; com várias, o cliente escolhe. Na NFC-e e no cupom sai uma linha só, a do combo. Use o setor &quot;Sem produção&quot; para o combo.
        </p>
      )}

      <h4 className="mb-2 mt-2 text-sm font-bold text-slate-700">Fiscal (NFC-e)</h4>
      <div className="grid grid-cols-3 gap-x-3">
        <Field label="NCM" hint="8 dígitos"><TextInput inputMode="numeric" value={f.ncm} maxLength={8} onChange={(e) => up('ncm', e.target.value.replace(/\D/g, ''))} /></Field>
        <Field label="CFOP" hint="4 dígitos"><TextInput inputMode="numeric" value={f.cfop} maxLength={4} onChange={(e) => up('cfop', e.target.value.replace(/\D/g, ''))} /></Field>
        <Field label="CSOSN/CST"><TextInput inputMode="numeric" value={f.csosn_cst} maxLength={4} onChange={(e) => up('csosn_cst', e.target.value.replace(/\D/g, ''))} /></Field>
      </div>

      <h4 className="mb-2 mt-2 text-sm font-bold text-slate-700">Adicionais deste produto (na ordem em que aparecem)</h4>
      {groups.length === 0 && <p className="text-sm text-slate-500">Nenhum grupo de adicionais cadastrado.</p>}
      <div className="flex flex-wrap gap-2">
        {groups.map((g) => {
          const pos = f.groupIds.indexOf(g.id);
          return (
            <button key={g.id} onClick={() => toggleGroup(g.id)} className={`min-h-touch rounded-full px-3 text-sm font-semibold ${pos >= 0 ? 'bg-ouro text-slate-950' : 'bg-slate-200 text-slate-800'}`}>
              {pos >= 0 && `${pos + 1}. `}{g.name}{g.required && ' *'}
            </button>
          );
        })}
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// CATEGORIAS
// ---------------------------------------------------------------------------
function CategoriesPanel() {
  const categories = useTcheStore((s) => s.categories);
  const products = useTcheStore((s) => s.products);
  const [editing, setEditing] = useState<Category | 'new' | null>(null);
  const sorted = [...categories].sort((a, b) => a.sort_order - b.sort_order);
  return (
    <Panel title="Categorias" action={<Btn variant="gold" onClick={() => setEditing('new')}><Plus className="h-4 w-4" /> Nova categoria</Btn>}>
      <div className="divide-y divide-slate-200 rounded-xl bg-base">
        {sorted.map((c) => (
          <div key={c.id} className={`flex items-center gap-3 p-3 ${c.active ? '' : 'opacity-50'}`}>
            <span className="w-8 text-center font-mono text-xs text-slate-500">{c.sort_order}</span>
            <div className="flex-1">
              <div className="font-bold">{c.name}{!c.active && <Badge className="ml-2 bg-neutral-500 text-white">desativada</Badge>}</div>
              <div className="text-xs text-slate-500">{products.filter((p) => p.category_id === c.id && p.active).length} produto(s) ativo(s)</div>
            </div>
            <Btn variant="ghost" aria-label={`Editar ${c.name}`} onClick={() => setEditing(c)}><Pencil className="h-4 w-4" /></Btn>
          </div>
        ))}
        {sorted.length === 0 && <p className="p-4 text-center text-sm text-slate-500">Nenhuma categoria.</p>}
      </div>
      {editing && <CategoryEditor category={editing === 'new' ? null : editing} nextOrder={(sorted.at(-1)?.sort_order ?? 0) + 1} onClose={() => setEditing(null)} />}
    </Panel>
  );
}

function CategoryEditor({ category, nextOrder, onClose }: { category: Category | null; nextOrder: number; onClose: () => void }) {
  const save = useTcheStore((s) => s.saveCategory);
  const [name, setName] = useState(category?.name ?? '');
  const [order, setOrder] = useState(String(category?.sort_order ?? nextOrder));
  const [icon, setIcon] = useState(category?.icon_name ?? '');
  const [active, setActive] = useState(category?.active ?? true);
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    const sort = parseIntInput(order);
    if (Number.isNaN(sort)) return setError('Ordem deve ser um número inteiro.');
    const r = save({ id: category?.id, name, sort_order: sort, icon_name: icon || null, active });
    if (!r.ok) return setError(r.error);
    toast.success(`Categoria ${r.data.name} salva.`);
    onClose();
  };
  return (
    <Sheet open onClose={onClose} title={category ? `Editar ${category.name}` : 'Nova categoria'} footer={<Btn block size="lg" onClick={submit}>Salvar categoria</Btn>}>
      <FormError error={error} />
      <Field label="Nome"><TextInput value={name} maxLength={100} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Ordem no cardápio" hint="Menor aparece primeiro."><TextInput inputMode="numeric" value={order} onChange={(e) => setOrder(e.target.value)} /></Field>
      <Field label="Ícone (opcional)" hint="Nome de ícone lucide, ex.: beef, wine, pizza."><TextInput value={icon} maxLength={50} onChange={(e) => setIcon(e.target.value)} /></Field>
      <Toggle label="Ativa" checked={active} onChange={setActive} />
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// ADICIONAIS
// ---------------------------------------------------------------------------
function ModifiersPanel() {
  const products = useTcheStore((s) => s.products);
  const groups = useTcheStore((s) => s.modifierGroups);
  const options = useTcheStore((s) => s.modifierOptions);
  const links = useTcheStore((s) => s.productModifierGroups);
  const [editingGroup, setEditingGroup] = useState<ModifierGroup | 'new' | null>(null);
  const [editingOption, setEditingOption] = useState<{ group: ModifierGroup; option: ModifierOption | null } | null>(null);
  const removeOption = useTcheStore((s) => s.removeModifierOption);
  return (
    <Panel title="Grupos de adicionais" action={<Btn variant="gold" onClick={() => setEditingGroup('new')}><Plus className="h-4 w-4" /> Novo grupo</Btn>}>
      <p className="mb-3 text-xs text-slate-500">Ex.: "Acompanhamento" (escolha 1, obrigatório) ou "Extras" (até 3, opcional). Vincule o grupo ao produto na edição do produto.</p>
      <div className="space-y-3">
        {groups.map((g) => {
          const opts = options.filter((o) => o.group_id === g.id);
          return (
            <div key={g.id} className="rounded-xl bg-base p-3">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <div className="flex-1">
                  <div className="font-bold">{g.name}</div>
                  <div className="text-xs text-slate-500">
                    {g.required ? 'Obrigatório' : 'Opcional'} · mín. {g.min_selection} · máx. {g.max_selection} · em {links.filter((l) => l.group_id === g.id).length} produto(s)
                  </div>
                </div>
                <Btn variant="ghost" aria-label={`Editar grupo ${g.name}`} onClick={() => setEditingGroup(g)}><Pencil className="h-4 w-4" /></Btn>
                <Btn variant="secondary" onClick={() => setEditingOption({ group: g, option: null })}><Plus className="h-4 w-4" /> Opção</Btn>
              </div>
              <div className="divide-y divide-slate-200">
                {opts.map((o) => (
                  <div key={o.id} className="flex items-center gap-2 py-2 text-sm">
                    <span className="flex-1">
                      {o.name}
                      {o.component_product_id && (
                        <span className="ml-2 rounded bg-slate-200 px-1.5 text-[11px] text-slate-700">
                          combo: {o.component_quantity}× {products.find((p) => p.id === o.component_product_id)?.name ?? 'produto removido'}
                        </span>
                      )}
                    </span>
                    <span className="tabular-nums text-slate-700">{o.additional_price > 0 ? `+ ${formatBRL(o.additional_price)}` : 'sem custo'}</span>
                    <Btn variant="ghost" aria-label={`Editar ${o.name}`} onClick={() => setEditingOption({ group: g, option: o })}><Pencil className="h-4 w-4" /></Btn>
                    <Btn
                      variant="ghost"
                      aria-label={`Remover ${o.name}`}
                      onClick={() => {
                        if (!window.confirm(`Remover a opção "${o.name}"? Itens já lançados não mudam.`)) return;
                        const r = removeOption(o.id);
                        if (!r.ok) toast.error(r.error);
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Btn>
                  </div>
                ))}
                {opts.length === 0 && <p className="py-2 text-sm text-slate-500">Sem opções ainda.</p>}
              </div>
            </div>
          );
        })}
        {groups.length === 0 && <p className="p-4 text-center text-sm text-slate-500">Nenhum grupo de adicionais.</p>}
      </div>
      {editingGroup && <GroupEditor group={editingGroup === 'new' ? null : editingGroup} onClose={() => setEditingGroup(null)} />}
      {editingOption && <OptionEditor group={editingOption.group} option={editingOption.option} onClose={() => setEditingOption(null)} />}
    </Panel>
  );
}

function GroupEditor({ group, onClose }: { group: ModifierGroup | null; onClose: () => void }) {
  const save = useTcheStore((s) => s.saveModifierGroup);
  const [name, setName] = useState(group?.name ?? '');
  const [min, setMin] = useState(String(group?.min_selection ?? 0));
  const [max, setMax] = useState(String(group?.max_selection ?? 1));
  const [required, setRequired] = useState(group?.required ?? false);
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    const mn = parseIntInput(min);
    const mx = parseIntInput(max);
    if (Number.isNaN(mn) || Number.isNaN(mx)) return setError('Mínimo e máximo devem ser números inteiros.');
    const r = save({ id: group?.id, name, min_selection: mn, max_selection: mx, required });
    if (!r.ok) return setError(r.error);
    toast.success(`Grupo ${r.data.name} salvo.`);
    onClose();
  };
  return (
    <Sheet open onClose={onClose} title={group ? `Editar ${group.name}` : 'Novo grupo de adicionais'} footer={<Btn block size="lg" onClick={submit}>Salvar grupo</Btn>}>
      <FormError error={error} />
      <Field label="Nome"><TextInput value={name} maxLength={100} onChange={(e) => setName(e.target.value)} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Mínimo de escolhas"><TextInput inputMode="numeric" value={min} onChange={(e) => setMin(e.target.value)} /></Field>
        <Field label="Máximo de escolhas"><TextInput inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value)} /></Field>
      </div>
      <Toggle label="Obrigatório (o garçom não lança sem escolher)" checked={required} onChange={setRequired} />
    </Sheet>
  );
}

function OptionEditor({ group, option, onClose }: { group: ModifierGroup; option: ModifierOption | null; onClose: () => void }) {
  const save = useTcheStore((s) => s.saveModifierOption);
  const products = useTcheStore((s) => s.products);
  const [name, setName] = useState(option?.name ?? '');
  const [price, setPrice] = useState(option ? moneyToInput(option.additional_price) : '0,00');
  const [component, setComponent] = useState(option?.component_product_id ?? '');
  const [componentQty, setComponentQty] = useState(String(option?.component_quantity ?? 1));
  const [error, setError] = useState<string | null>(null);
  const eligible = products
    .filter((p) => p.active && !p.is_combo && !p.sold_by_weight)
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  const submit = () => {
    const p = parseMoneyInput(price);
    if (Number.isNaN(p)) return setError('Valor inválido. Use 0,00 para sem custo.');
    const r = save({
      id: option?.id,
      group_id: group.id,
      name,
      additional_price: p,
      component_product_id: component || null,
      component_quantity: Number(componentQty),
    });
    if (!r.ok) return setError(r.error);
    toast.success(`${r.data.name} salvo em ${group.name}.`);
    onClose();
  };
  return (
    <Sheet open onClose={onClose} title={option ? `Editar ${option.name}` : `Nova opção em ${group.name}`} footer={<Btn block size="lg" onClick={submit}>Salvar opção</Btn>}>
      <FormError error={error} />
      <Field label="Nome"><TextInput value={name} maxLength={100} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Valor adicional (R$)" hint="Vale para os próximos lançamentos; itens já lançados não mudam."><TextInput inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} /></Field>
      <Field label="Produto do combo" hint="Só em grupo de combo: a opção coloca este produto no pedido, na praça dele. Deixe em branco para um adicional comum.">
        <Select
          value={component}
          onChange={(v) => {
            setComponent(v);
            if (v && !name.trim()) setName(products.find((p) => p.id === v)?.name ?? '');
          }}
          options={[{ value: '', label: '— adicional comum —' }, ...eligible.map((p) => ({ value: p.id, label: `${p.code} ${p.name}` }))]}
        />
      </Field>
      {component && (
        <Field label="Quantidade no combo" hint="Unidades deste produto em cada combo (1 a 20).">
          <TextInput inputMode="numeric" value={componentQty} maxLength={2} onChange={(e) => setComponentQty(e.target.value.replace(/\D/g, ''))} />
        </Field>
      )}
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// PREÇO POR HORÁRIO
// ---------------------------------------------------------------------------
function SchedulesPanel() {
  const schedules = useTcheStore((s) => s.priceSchedules);
  const products = useTcheStore((s) => s.products);
  const [editing, setEditing] = useState<PriceSchedule | 'new' | null>(null);
  const now = new Date();
  const sorted = [...schedules].sort((a, b) => (products.find((p) => p.id === a.product_id)?.name ?? '').localeCompare(products.find((p) => p.id === b.product_id)?.name ?? '', 'pt-BR'));
  return (
    <Panel title="Preço por dia e horário" action={<Btn variant="gold" onClick={() => setEditing('new')}><Plus className="h-4 w-4" /> Nova regra</Btn>}>
      <p className="mb-3 text-xs text-slate-500">Happy hour, almoço executivo, rodízio de domingo. Fora da janela vale o preço do cadastro. Duas regras do mesmo produto não podem se sobrepor. O horário é o do relógio deste aparelho.</p>
      <div className="divide-y divide-slate-200 rounded-xl bg-base">
        {sorted.map((s) => {
          const p = products.find((x) => x.id === s.product_id);
          const live = activeSchedule(s.product_id, schedules, now)?.id === s.id;
          return (
            <div key={s.id} className={`flex flex-wrap items-center gap-3 p-3 ${s.active ? '' : 'opacity-50'}`}>
              <div className="min-w-0 flex-1">
                <div className="font-bold">{s.name} · {p?.name ?? 'produto removido'}{live && <Badge className="ml-2 bg-stone text-white">valendo agora</Badge>}{!s.active && <Badge className="ml-2 bg-neutral-500 text-white">pausada</Badge>}</div>
                <div className="text-xs text-slate-500">
                  {s.weekdays.map((d) => WEEKDAY_SHORT[d]).join(', ')} · {s.start_time}–{s.end_time}{s.end_time < s.start_time && ' (vira a meia-noite)'} · {formatBRL(s.price)} {p && <span>(normal {formatBRL(p.price)})</span>}
                </div>
              </div>
              <Btn variant="ghost" aria-label={`Editar ${s.name}`} onClick={() => setEditing(s)}><Pencil className="h-4 w-4" /></Btn>
            </div>
          );
        })}
        {sorted.length === 0 && <p className="p-4 text-center text-sm text-slate-500">Nenhuma regra de horário.</p>}
      </div>
      {editing && <ScheduleEditor schedule={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </Panel>
  );
}

function ScheduleEditor({ schedule, onClose }: { schedule: PriceSchedule | null; onClose: () => void }) {
  const products = useTcheStore((s) => s.products);
  const save = useTcheStore((s) => s.savePriceSchedule);
  const options = products.filter((p) => p.active || p.id === schedule?.product_id).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  const [productId, setProductId] = useState(schedule?.product_id ?? options[0]?.id ?? '');
  const [name, setName] = useState(schedule?.name ?? 'Happy hour');
  const [days, setDays] = useState<number[]>(schedule?.weekdays ?? [1, 2, 3, 4, 5]);
  const [start, setStart] = useState(schedule?.start_time ?? '18:00');
  const [end, setEnd] = useState(schedule?.end_time ?? '20:00');
  const [price, setPrice] = useState(schedule ? moneyToInput(schedule.price) : '');
  const [active, setActive] = useState(schedule?.active ?? true);
  const [error, setError] = useState<string | null>(null);
  const base = products.find((p) => p.id === productId);
  const submit = () => {
    const p = parseMoneyInput(price);
    if (Number.isNaN(p)) return setError('Preço inválido. Use o formato 19,90.');
    const r = save({ id: schedule?.id, product_id: productId, name, weekdays: days, start_time: start, end_time: end, price: p, active });
    if (!r.ok) return setError(r.error);
    toast.success(`Regra ${r.data.name} salva.`);
    onClose();
  };
  return (
    <Sheet open onClose={onClose} title={schedule ? `Editar ${schedule.name}` : 'Nova regra de preço'} footer={<Btn block size="lg" onClick={submit}>Salvar regra</Btn>}>
      <FormError error={error} />
      <Field label="Produto">
        <Select value={productId} disabled={Boolean(schedule)} onChange={setProductId} options={options.map((p) => ({ value: p.id, label: `${p.code} · ${p.name} (${formatBRL(p.price)})` }))} />
      </Field>
      <Field label="Nome da regra"><TextInput value={name} maxLength={60} onChange={(e) => setName(e.target.value)} /></Field>
      <div className="mb-3">
        <span className="mb-1 block text-sm font-semibold text-slate-700">Dias da semana</span>
        <div className="flex flex-wrap gap-2">
          {WEEKDAY_SHORT.map((label, d) => (
            <button key={label} onClick={() => setDays(days.includes(d) ? days.filter((x) => x !== d) : [...days, d])} className={`min-h-touch min-w-[56px] rounded-xl px-2 text-sm font-bold ${days.includes(d) ? 'bg-ouro text-slate-950' : 'bg-slate-200 text-slate-800'}`}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Começa"><TextInput type="time" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
        <Field label="Termina" hint="Antes do início = vira a meia-noite."><TextInput type="time" value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
      </div>
      <Field label="Preço na janela (R$)" hint={base ? `Preço normal: ${formatBRL(base.price)}` : undefined}><TextInput inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} /></Field>
      <Toggle label="Regra ativa" checked={active} onChange={setActive} />
    </Sheet>
  );
}
