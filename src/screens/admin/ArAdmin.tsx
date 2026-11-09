/**
 * Retaguarda > Cardápio > Realidade aumentada: modelo 3D por produto, tamanho real,
 * etiquetas dos itens do prato e o engajamento dos clientes com o 3D.
 */
import { useEffect, useMemo, useState } from 'react';
import { CloudUpload, Crosshair, Pencil, Plus, Rotate3d, Trash2, Upload } from 'lucide-react';
import { useTcheStore } from '../../store/useTcheStore';
import { isLocalOnly, useArStore } from '../../store/useArStore';
import type { ArComponent, Product, ProductArModel } from '../../types';
import { AR_DETAIL_MAX, AR_LABEL_MAX, AR_MAX_COMPONENTS, arEngagement, formatArSize, formatCm, scaleFactorFor } from '../../lib/ar/arModels';
import { checkModelFile, readModelFile, storeModelFile } from '../../lib/ar/modelFiles';
import { storagePath, uploadModelFile } from '../../lib/ar/modelUpload';
import { needsRefresh, refreshDevice } from '../../lib/sync/supabaseSync';
import { uuid } from '../../lib/ids';
import { ModelViewer, type ModelInfo } from '../../components/ar/ModelViewer';
import { Badge, Btn, Sheet, toast } from '../../components/ui';
import { Field, FormError, Panel, Select, TextInput, Toggle, parseMoneyInput } from './fields';

const DAYS = 30;

/** Sobe os arquivos idb:… do modelo para o bucket e troca pelos links. */
async function publishToCloud(model: ProductArModel, files: { glb?: Blob | null; usdz?: Blob | null } = {}): Promise<string | null> {
  const cloud = useTcheStore.getState().cloud;
  if (!cloud) return 'Conecte a loja à nuvem (aba Nuvem) para os celulares dos clientes abrirem o 3D.';
  const fetchFn = (u: string, init: { method: string; headers: Record<string, string>; body: Blob }) => fetch(u, init);
  try {
    // Sem nada na fila, o laço de sincronização não renova o token: renova aqui antes do envio.
    let accessToken = cloud.access_token;
    if (needsRefresh(cloud.expires_at)) {
      const t = await refreshDevice(cloud.url, cloud.anon_key, cloud.refresh_token, (u, init) => fetch(u, init));
      const saved = useTcheStore.getState().setCloudSession({ ...cloud, ...t });
      if (!saved.ok) return saved.error;
      accessToken = t.access_token;
    }
    const target = { url: cloud.url, anonKey: cloud.anon_key, accessToken };
    let glb = model.glb_url;
    let usdz = model.usdz_url;
    if (glb.startsWith('idb:')) {
      const blob = files.glb ?? (await readModelFile(glb));
      if (!blob) return 'Arquivo .glb não está mais neste aparelho. Envie de novo.';
      glb = await uploadModelFile(target, storagePath(model.tenant_id, model.id, 'glb', Date.now()), blob, 'glb', fetchFn);
    }
    if (usdz?.startsWith('idb:')) {
      const blob = files.usdz ?? (await readModelFile(usdz));
      if (!blob) return 'Arquivo .usdz não está mais neste aparelho. Envie de novo.';
      usdz = await uploadModelFile(target, storagePath(model.tenant_id, model.id, 'usdz', Date.now()), blob, 'usdz', fetchFn);
    }
    const r = useArStore.getState().setArModelUrls(model.product_id, { glb_url: glb, usdz_url: usdz });
    return r.ok ? null : r.error;
  } catch (e) {
    return (e as Error).message;
  }
}

export function ArAdmin() {
  const products = useTcheStore((s) => s.products);
  const tenantId = useTcheStore((s) => s.tenant.id);
  const allModels = useArStore((s) => s.arModels);
  const allEvents = useArStore((s) => s.arEvents);
  // O store do 3D é do aparelho: depois de "começar loja nova", os dados da loja anterior ficam de fora.
  const models = useMemo(() => allModels.filter((m) => m.tenant_id === tenantId), [allModels, tenantId]);
  const events = useMemo(() => allEvents.filter((e) => e.tenant_id === tenantId), [allEvents, tenantId]);
  const ensureDemoModel = useArStore((s) => s.ensureDemoModel);
  const [editing, setEditing] = useState<Product | null>(null);
  const [q, setQ] = useState('');
  useEffect(() => ensureDemoModel(), [ensureDemoModel]);

  const since = useMemo(() => new Date(Date.now() - DAYS * 86_400_000).toISOString(), []);
  const stats = useMemo(() => arEngagement(events, since), [events, since]);
  const byProduct = new Map(stats.map((s) => [s.product_id, s]));
  const totals = stats.reduce((a, s) => ({ v: a.v + s.views3d, ar: a.ar + s.arStarts, add: a.add + s.addsAfterView }), { v: 0, ar: 0, add: 0 });
  const term = q.trim().toLowerCase();
  const list = products
    .filter((p) => p.active && !p.sold_by_weight)
    .filter((p) => !term || p.name.toLowerCase().includes(term) || p.code.includes(term))
    .sort((a, b) => Number(models.some((m) => m.product_id === b.id)) - Number(models.some((m) => m.product_id === a.id)) || a.code.localeCompare(b.code, 'pt-BR', { numeric: true }));

  const sendNow = async (m: ProductArModel) => {
    const err = await publishToCloud(m);
    if (err) toast.error(err);
    else toast.success('Modelo 3D enviado para a nuvem. Já abre no celular dos clientes.');
  };

  return (
    <div className="space-y-3">
      <Panel title={<span className="flex items-center gap-2"><Rotate3d className="h-5 w-5" /> Cardápio em realidade aumentada</span>}>
        <p className="mb-3 text-sm text-slate-500">
          O cliente toca no prato pelo QR da mesa, vê em 3D, coloca na mesa no tamanho real e abre os itens que vêm nele. Funciona no navegador do Android e do iPhone, sem instalar app.
          Cada prato precisa do seu modelo 3D (.glb): veja em <b>docs/cardapio-ar.md</b> como fazer pelo celular.
        </p>
        <div className="grid grid-cols-3 gap-2 text-center">
          <Kpi label={`Aberturas do 3D (${DAYS} dias)`} value={totals.v} />
          <Kpi label="Colocaram na mesa (AR)" value={totals.ar} />
          <Kpi label="Pediram depois de ver" value={totals.add} hint={totals.v ? `${Math.round((totals.add / totals.v) * 100)}% das aberturas` : undefined} />
        </div>
      </Panel>

      <Panel title={`Pratos (${models.filter((m) => m.active).length} com 3D ativo)`}>
        <TextInput placeholder="Buscar por nome ou código" value={q} onChange={(e) => setQ(e.target.value)} className="mb-3" />
        <div className="divide-y divide-slate-200 rounded-xl bg-base">
          {list.map((p) => {
            const m = models.find((x) => x.product_id === p.id);
            const st = byProduct.get(p.id);
            return (
              <div key={p.id} className="flex flex-wrap items-center gap-3 p-3">
                <span className="w-10 font-mono text-xs text-slate-500">{p.code}</span>
                <div className="min-w-0 flex-1">
                  <div className="font-bold">
                    {p.name}
                    {m && (m.active ? <Badge className="ml-2 bg-stone text-white">3D ativo</Badge> : <Badge className="ml-2 bg-slate-200 text-slate-700">3D desligado</Badge>)}
                    {m && isLocalOnly(m) && <Badge className="ml-2 bg-ouro text-slate-950">só neste aparelho</Badge>}
                    {m?.glb_url.startsWith('ar/') && <Badge className="ml-2 bg-slate-200 text-slate-700">demonstração</Badge>}
                  </div>
                  {m ? (
                    <div className="text-xs text-slate-500">
                      {formatArSize(m)} · {m.components.length} item(ns) com etiqueta
                      {st && ` · ${st.views3d} aberturas · ${st.arStarts} na mesa · ${st.explodes} viram os itens · ${st.addsAfterView} pedidos${st.conversionPct !== null ? ` (${st.conversionPct}%)` : ''}`}
                    </div>
                  ) : (
                    <div className="text-xs text-slate-500">Sem modelo 3D</div>
                  )}
                </div>
                {m && isLocalOnly(m) && <Btn variant="secondary" onClick={() => void sendNow(m)}><CloudUpload className="h-4 w-4" /> Enviar</Btn>}
                <Btn variant={m ? 'ghost' : 'gold'} onClick={() => setEditing(p)}>{m ? <><Pencil className="h-4 w-4" /> Editar</> : <><Plus className="h-4 w-4" /> 3D</>}</Btn>
              </div>
            );
          })}
        </div>
      </Panel>
      {editing && <ArModelEditor product={editing} model={models.find((m) => m.product_id === editing.id) ?? null} onClose={() => setEditing(null)} />}
    </div>
  );
}

function Kpi({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="rounded-xl bg-base p-3">
      <div className="text-2xl font-black">{value}</div>
      <div className="text-xs text-slate-500">{label}</div>
      {hint && <div className="text-xs font-bold text-brasa">{hint}</div>}
    </div>
  );
}

function ArModelEditor({ product, model, onClose }: { product: Product; model: ProductArModel | null; onClose: () => void }) {
  const save = useArStore((s) => s.saveArModel);
  const remove = useArStore((s) => s.removeArModel);
  const [glbUrl, setGlbUrl] = useState(model?.glb_url ?? '');
  const [glbFile, setGlbFile] = useState<File | null>(null);
  const [glbPreview, setGlbPreview] = useState<string | null>(null);
  const [usdzUrl, setUsdzUrl] = useState<string | null>(model?.usdz_url ?? null);
  const [usdzFile, setUsdzFile] = useState<File | null>(null);
  const [linkInput, setLinkInput] = useState(model?.glb_url.startsWith('https://') ? model.glb_url : '');
  const [info, setInfo] = useState<ModelInfo | null>(null);
  const [realMax, setRealMax] = useState(model ? formatCm(Math.max(model.real_width_cm, model.real_depth_cm)) : '');
  const [anim, setAnim] = useState<string>(model?.explode_animation ?? '');
  const [items, setItems] = useState<ArComponent[]>(model?.components ?? []);
  const [placing, setPlacing] = useState<string | null>(null);
  const [active, setActive] = useState(model?.active ?? true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // O preview usa o arquivo recém-escolhido (blob:) antes de ir para o aparelho/nuvem.
  const previewRef = glbPreview ?? (glbUrl || null);
  const rawMax = info ? Math.max(info.rawCm.x, info.rawCm.z) : 0;
  const real = parseMoneyInput(realMax);
  const factor = info && real > 0 ? scaleFactorFor(rawMax, real) : model?.scale_factor ?? 1;
  const dims = info ? { real_width_cm: info.rawCm.x * factor, real_depth_cm: info.rawCm.z * factor, real_height_cm: info.rawCm.y * factor } : model;

  const pickGlb = (f: File | undefined) => {
    if (!f) return;
    const err = checkModelFile(f, 'glb');
    if (err) return setError(err);
    setError(null);
    setInfo(null);
    setGlbFile(f);
    if (glbPreview) URL.revokeObjectURL(glbPreview);
    setGlbPreview(URL.createObjectURL(f));
    setRealMax('');
  };
  const pickUsdz = (f: File | undefined) => {
    if (!f) return;
    const err = checkModelFile(f, 'usdz');
    if (err) return setError(err);
    setError(null);
    setUsdzFile(f);
  };
  const useLink = () => {
    const v = linkInput.trim();
    if (!/^https:\/\/\S+\.glb(\?\S*)?$/i.test(v)) return setError('O link precisa ser https e terminar em .glb.');
    setError(null);
    // Mesmo link já na prévia: o 3D não recarrega nem mede de novo, então a medida fica.
    if (!glbFile && v === glbUrl) return;
    setInfo(null);
    setGlbFile(null);
    setGlbPreview(null);
    setGlbUrl(v);
  };

  const onInfo = (i: ModelInfo) => {
    setInfo(i);
    if (!realMax) setRealMax(formatCm(Math.max(i.rawCm.x, i.rawCm.z) * (model && previewRef === model.glb_url ? model.scale_factor : 1)));
    if (!anim && i.animations.length === 1) setAnim(i.animations[0]!);
  };

  const onPick = (position: string, normal: string) => {
    if (!placing) return;
    setItems((list) => list.map((c) => (c.id === placing ? { ...c, position, normal } : c)));
    setPlacing(null);
  };

  const addItem = () => {
    const id = uuid();
    setItems((l) => [...l, { id, label: '', detail: null, position: '', normal: '' }]);
    setPlacing(id);
  };

  const submit = async () => {
    if (!previewRef) return setError('Escolha o arquivo .glb do prato.');
    if (!info || !dims) return setError('Espere o 3D carregar para conferir o tamanho.');
    if (!(real > 0)) return setError('Informe a maior medida real do prato, em cm.');
    setBusy(true);
    try {
      const glbRef = glbFile ? await storeModelFile(glbFile) : glbUrl;
      const usdzRef = usdzFile ? await storeModelFile(usdzFile) : usdzUrl;
      const r = save({
        id: model?.id,
        product_id: product.id,
        glb_url: glbRef,
        usdz_url: usdzRef,
        scale_factor: factor,
        real_width_cm: dims.real_width_cm,
        real_depth_cm: dims.real_depth_cm,
        real_height_cm: dims.real_height_cm,
        explode_animation: anim || null,
        components: items,
        active,
      });
      if (!r.ok) return setError(r.error);
      if (isLocalOnly(r.data) && useTcheStore.getState().cloud) {
        const err = await publishToCloud(r.data, { glb: glbFile, usdz: usdzFile });
        if (err) toast.alert(`3D salvo neste aparelho. ${err}`);
        else toast.success(`3D de ${product.name} salvo e enviado para a nuvem.`);
      } else if (isLocalOnly(r.data)) {
        toast.alert(`3D de ${product.name} salvo neste aparelho. Conecte a nuvem para os clientes abrirem pelo QR.`);
      } else toast.success(`3D de ${product.name} salvo.`);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const del = () => {
    if (!model) return onClose();
    const r = remove(product.id);
    if (!r.ok) return setError(r.error);
    toast.info(`3D de ${product.name} removido do cardápio.`);
    onClose();
  };

  const previewModel = {
    glb_url: previewRef ?? '',
    usdz_url: null,
    scale_factor: factor,
    explode_animation: anim || null,
    components: items.filter((c) => c.position),
    real_width_cm: dims?.real_width_cm ?? 0,
    real_depth_cm: dims?.real_depth_cm ?? 0,
    real_height_cm: dims?.real_height_cm ?? 0,
  };

  return (
    <Sheet
      open
      onClose={onClose}
      wide
      title={`3D de ${product.name}`}
      footer={
        <div className="flex gap-2">
          {model && <Btn variant="danger" onClick={del}><Trash2 className="h-4 w-4" /> Remover 3D</Btn>}
          <Btn block size="lg" disabled={busy} onClick={() => void submit()}>{busy ? 'Salvando…' : 'Salvar 3D'}</Btn>
        </div>
      }
    >
      <FormError error={error} />
      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        {/* Fica à vista enquanto rola a lista de itens, para tocar no modelo. */}
        <div className="z-10 self-start lg:sticky lg:top-0">
          <div className="relative h-80 overflow-hidden rounded-2xl">
            {previewRef ? (
              // Prévia sempre na escala 1: mede o arquivo como veio (getDimensions já inclui o
              // scale) e as etiquetas ficam em coordenadas do modelo. Remonta ao trocar de arquivo.
              <ModelViewer key={previewRef} model={{ ...previewModel, scale_factor: 1 }} alt={product.name} variant="admin" onInfo={onInfo} onPick={placing ? onPick : undefined} highlightId={placing} className="h-full" />
            ) : (
              <div className="grid h-full place-items-center bg-base p-6 text-center text-sm text-slate-500">Escolha o arquivo .glb do prato para ver aqui.</div>
            )}
            {placing && <div className="pointer-events-none absolute inset-x-2 bottom-2 rounded-lg bg-ouro px-2 py-1 text-center text-xs font-black text-slate-950"><Crosshair className="mr-1 inline h-4 w-4" />Toque no modelo onde fica a etiqueta</div>}
          </div>
          {info && (
            <p className="mt-2 text-xs text-slate-500">
              O arquivo mede {formatCm(info.rawCm.x)} × {formatCm(info.rawCm.z)} × {formatCm(info.rawCm.y)} cm. No cardápio: <b className="text-slate-800">{dims && formatArSize(dims)}</b>
              {factor !== 1 && ` (escala ${String(factor).replace('.', ',')}×)`}.
            </p>
          )}
        </div>

        <div>
          <Field label="Modelo 3D (.glb)" hint="Até 15 MB. Exporte em metros: 1 unidade = 1 metro.">
            <label className="flex min-h-touch cursor-pointer items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-300 px-3 text-sm font-bold">
              <Upload className="h-4 w-4" /> {glbFile ? glbFile.name : 'Escolher arquivo .glb'}
              <input type="file" accept=".glb,model/gltf-binary" className="hidden" onChange={(e) => pickGlb(e.target.files?.[0])} />
            </label>
          </Field>
          <Field label="Ou link https do .glb">
            <div className="flex gap-2">
              <TextInput value={linkInput} onChange={(e) => setLinkInput(e.target.value)} placeholder="https://…/prato.glb" />
              <Btn variant="secondary" onClick={useLink}>Usar</Btn>
            </div>
          </Field>
          <Field label="iPhone (.usdz, opcional)" hint="Sem ele, o iPhone gera o USDZ a partir do .glb.">
            <label className="flex min-h-touch cursor-pointer items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-300 px-3 text-sm font-bold">
              <Upload className="h-4 w-4" /> {usdzFile ? usdzFile.name : usdzUrl ? 'Trocar .usdz' : 'Escolher arquivo .usdz'}
              <input type="file" accept=".usdz,model/vnd.usdz+zip" className="hidden" onChange={(e) => pickUsdz(e.target.files?.[0])} />
            </label>
            {(usdzUrl || usdzFile) && <button className="mt-1 text-xs text-rose-600 underline" onClick={() => { setUsdzUrl(null); setUsdzFile(null); }}>Tirar o .usdz</button>}
          </Field>
          <Field label="Maior medida real do prato (cm)" hint="Ex.: pizza de 35 cm, prato de 28 cm. O 3D é ajustado para ficar desse tamanho na mesa.">
            <TextInput inputMode="decimal" value={realMax} onChange={(e) => setRealMax(e.target.value)} placeholder="35" />
          </Field>
          {info && info.animations.length > 0 && (
            <Field label="Animação que separa os itens" hint="Tocada no botão “Ver os itens” do cliente.">
              <Select value={anim} onChange={setAnim} options={[{ value: '', label: 'Nenhuma (só etiquetas)' }, ...info.animations.map((a) => ({ value: a, label: a }))]} />
            </Field>
          )}
          <Toggle label="Mostrar no cardápio do cliente" checked={active} onChange={setActive} />
        </div>
      </div>

      <h4 className="mb-2 mt-3 text-sm font-bold text-slate-700">Itens do prato (etiquetas no 3D)</h4>
      <p className="mb-2 text-xs text-slate-500">Toque em “Posicionar” e depois no ponto do modelo. Com animação, posicione com os itens já separados (como o 3D aparece aqui).</p>
      <div className="space-y-2">
        {items.map((c, i) => (
          <div key={c.id} className={`grid grid-cols-[auto_1fr_1fr_auto_auto] items-center gap-2 rounded-xl p-2 ${placing === c.id ? 'bg-ouro/20' : 'bg-base'}`}>
            <span className="grid h-6 w-6 place-items-center rounded-full bg-brasa text-xs font-bold text-white">{i + 1}</span>
            <TextInput value={c.label} maxLength={AR_LABEL_MAX} placeholder="Ex.: Mussarela" onChange={(e) => setItems((l) => l.map((x) => (x.id === c.id ? { ...x, label: e.target.value } : x)))} />
            <TextInput value={c.detail ?? ''} maxLength={AR_DETAIL_MAX} placeholder="Detalhe (opcional)" onChange={(e) => setItems((l) => l.map((x) => (x.id === c.id ? { ...x, detail: e.target.value } : x)))} />
            <Btn variant={c.position ? 'ghost' : 'gold'} aria-label={`Posicionar ${c.label || 'item'}`} onClick={() => setPlacing(placing === c.id ? null : c.id)}><Crosshair className="h-4 w-4" /> {c.position ? 'Mover' : 'Posicionar'}</Btn>
            <Btn variant="ghost" aria-label={`Remover ${c.label || 'item'}`} onClick={() => setItems((l) => l.filter((x) => x.id !== c.id))}><Trash2 className="h-4 w-4" /></Btn>
          </div>
        ))}
      </div>
      {items.length < AR_MAX_COMPONENTS && <Btn variant="secondary" className="mt-2" disabled={!info} onClick={addItem}><Plus className="h-4 w-4" /> Adicionar item</Btn>}
    </Sheet>
  );
}
