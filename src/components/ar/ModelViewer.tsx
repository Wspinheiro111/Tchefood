/**
 * Visualizador 3D + realidade aumentada do cardápio, sobre o <model-viewer> do Google.
 *
 * Sem app para instalar:
 *  - Android: WebXR no Chrome (as etiquetas aparecem na mesa) ou Scene Viewer;
 *  - iPhone/iPad: Quick Look (usa o USDZ enviado ou gera um a partir do GLB);
 *  - computador ou celular sem AR: 3D que gira com o dedo/mouse.
 * ar-scale="fixed" mantém o prato no tamanho real (o arquivo está em metros, padrão glTF).
 *
 * A biblioteca (com o three.js) só é baixada quando o cliente abre um 3D.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Layers, Loader2, Move3d, Smartphone } from 'lucide-react';
import type { ArComponent, ArEngagementKind, ProductArModel } from '../../types';
import { formatArSize } from '../../lib/ar/arModels';
import { resolveModelUrl } from '../../lib/ar/modelFiles';

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Parte da API do <model-viewer> que usamos (ver modelviewer.dev/docs). */
export interface ModelViewerElement extends HTMLElement {
  src: string;
  loaded: boolean;
  canActivateAR: boolean;
  availableAnimations: string[];
  animationName: string | undefined;
  currentTime: number;
  duration: number;
  play(options?: { repetitions?: number }): void;
  pause(): void;
  getDimensions(): Vec3;
  positionAndNormalFromPoint(x: number, y: number): { position: Vec3; normal: Vec3 } | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      'model-viewer': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & Record<string, unknown>;
    }
  }
}

let libPromise: Promise<unknown> | null = null;
/** Carrega o <model-viewer> uma vez só (chunk separado no build). */
export function loadModelViewer(): Promise<unknown> {
  if (!libPromise) libPromise = import('@google/model-viewer');
  return libPromise;
}

export interface ModelInfo {
  /** Medidas do arquivo como veio (sem o fator de escala), em cm. */
  rawCm: Vec3;
  animations: string[];
}

interface Props {
  model: Pick<ProductArModel, 'glb_url' | 'usdz_url' | 'scale_factor' | 'explode_animation' | 'components' | 'real_width_cm' | 'real_depth_cm' | 'real_height_cm'>;
  alt: string;
  variant: 'customer' | 'admin';
  onEvent?: (kind: ArEngagementKind) => void;
  /** Retaguarda: toque no modelo devolve onde prender a etiqueta. */
  onPick?: (position: string, normal: string) => void;
  onInfo?: (info: ModelInfo) => void;
  highlightId?: string | null;
  className?: string;
}

const EXPLODE_MS = 900;

/** Último quadro da animação. Exatamente no fim ela dá a volta e cai no começo (loop). */
function endOf(el: ModelViewerElement): number {
  return Math.max(0, el.duration - 0.001);
}

function vec(v: Vec3): string {
  return [v.x, v.y, v.z].map((n) => Number(n.toFixed(4))).join(' ');
}

export function ModelViewer({ model, alt, variant, onEvent, onPick, onInfo, highlightId, className = '' }: Props) {
  const ref = useRef<ModelViewerElement | null>(null);
  const [libReady, setLibReady] = useState(false);
  const [src, setSrc] = useState<string | null>(null);
  const [iosSrc, setIosSrc] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [canAR, setCanAR] = useState(false);
  const [exploded, setExploded] = useState(variant === 'admin');
  const [hasExplode, setHasExplode] = useState(false);
  const [animating, setAnimating] = useState(false);
  const anim = useRef<number | null>(null);
  const measured = useRef<string | null>(null);
  const callbacks = useRef({ onEvent, onPick, onInfo });
  callbacks.current = { onEvent, onPick, onInfo };

  useEffect(() => {
    let alive = true;
    loadModelViewer().then(
      () => alive && setLibReady(true),
      () => alive && setState('error'),
    );
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    setState('loading');
    void Promise.all([resolveModelUrl(model.glb_url), model.usdz_url ? resolveModelUrl(model.usdz_url) : Promise.resolve(null)]).then(([g, u]) => {
      if (!alive) return;
      if (!g) return setState('error');
      setSrc(g);
      setIosSrc(u);
    });
    return () => {
      alive = false;
    };
  }, [model.glb_url, model.usdz_url]);

  // Eventos do elemento (o React 18 não liga eventos de custom elements).
  useEffect(() => {
    const el = ref.current;
    if (!el || !libReady) return;
    const onLoad = () => {
      setState('ready');
      setCanAR(el.canActivateAR);
      const anims = el.availableAnimations ?? [];
      const explode = Boolean(model.explode_animation && anims.includes(model.explode_animation));
      setHasExplode(explode);
      if (explode) {
        // O <model-viewer> só aplica currentTime depois de a animação ter tocado uma vez.
        el.animationName = model.explode_animation!;
        el.play();
        requestAnimationFrame(() => {
          el.pause();
          el.currentTime = variant === 'admin' ? endOf(el) : 0;
        });
      }
      // Mede uma vez por arquivo, ainda na pose de repouso (getDimensions ignora o atributo scale).
      if (measured.current !== el.src) {
        measured.current = el.src;
        const d = el.getDimensions();
        callbacks.current.onInfo?.({ rawCm: { x: d.x * 100, y: d.y * 100, z: d.z * 100 }, animations: anims });
      }
    };
    const onError = () => setState('error');
    const onClick = (e: MouseEvent) => {
      if (!callbacks.current.onPick) return;
      const hit = el.positionAndNormalFromPoint(e.clientX, e.clientY);
      if (hit) callbacks.current.onPick(vec(hit.position), vec(hit.normal));
    };
    el.addEventListener('load', onLoad);
    el.addEventListener('error', onError);
    el.addEventListener('click', onClick);
    if (el.loaded) onLoad();
    return () => {
      el.removeEventListener('load', onLoad);
      el.removeEventListener('error', onError);
      el.removeEventListener('click', onClick);
    };
  }, [libReady, src, model.explode_animation, variant]);

  useEffect(() => () => {
    if (anim.current !== null) cancelAnimationFrame(anim.current);
  }, []);

  /** Separa (ou junta) as camadas tocando a animação do arquivo até o fim, sem repetir. */
  const toggleExplode = () => {
    const el = ref.current;
    const next = !exploded;
    setExploded(next);
    if (next) callbacks.current.onEvent?.('EXPLODE');
    if (!el || !hasExplode) return;
    if (anim.current !== null) cancelAnimationFrame(anim.current);
    const from = el.currentTime;
    const to = next ? endOf(el) : 0;
    setAnimating(true);
    const start = performance.now();
    const ms = EXPLODE_MS * Math.abs(to - from) / (el.duration || 1);
    const step = (t: number) => {
      const k = ms === 0 ? 1 : Math.min(1, (t - start) / ms);
      const ease = 1 - (1 - k) ** 3;
      el.currentTime = from + (to - from) * ease;
      anim.current = k < 1 ? requestAnimationFrame(step) : null;
      if (k >= 1) setAnimating(false);
    };
    anim.current = requestAnimationFrame(step);
  };

  const f = model.scale_factor || 1;
  // Com os itens separados, a câmera mira o meio da pilha e se afasta para caber tudo.
  const stackTop = Math.max(0, ...model.components.map((c) => Number(c.position.split(/\s+/)[1]) || 0)) * f;
  const spread = (exploded || variant === 'admin') && stackTop > 0;
  const showLabels = exploded || variant === 'admin';

  return (
    <div className={`relative overflow-hidden bg-gradient-to-b from-slate-100 to-slate-300 ${className}`}>
      {libReady && src && (
        <model-viewer
          ref={ref}
          src={src}
          {...(iosSrc ? { 'ios-src': iosSrc } : {})}
          alt={alt}
          ar=""
          ar-modes="webxr scene-viewer quick-look"
          ar-scale="fixed"
          ar-placement="floor"
          camera-controls=""
          touch-action="pan-y"
          {...(variant === 'customer' && !exploded ? { 'auto-rotate': '' } : {})}
          camera-orbit={spread ? '25deg 72deg 165%' : '30deg 60deg auto'}
          camera-target={spread ? `0m ${(stackTop / 2).toFixed(3)}m 0m` : 'auto auto auto'}
          max-camera-orbit="auto auto 400%"
          shadow-intensity="1"
          environment-image="neutral"
          interaction-prompt="none"
          scale={`${f} ${f} ${f}`}
          style={{ width: '100%', height: '100%', '--poster-color': 'transparent', cursor: onPick ? 'crosshair' : undefined } as CSSProperties}
        >
          {model.components.map((c: ArComponent, i) => (
            <button
              key={c.id}
              slot={`hotspot-${c.id}`}
              data-position={c.position}
              data-normal={c.normal}
              data-visibility-attribute="visible"
              onClick={(e) => e.stopPropagation()}
              style={{ opacity: showLabels && !animating ? 1 : 0, pointerEvents: showLabels ? 'auto' : 'none', transition: 'opacity .25s' }}
              className={`whitespace-nowrap rounded-full border-2 px-2 py-0.5 text-left text-[11px] font-bold shadow-lg ${highlightId === c.id ? 'border-amber-400 bg-amber-300 text-slate-950' : 'border-white bg-slate-900/85 text-white'}`}
            >
              <span className="mr-1 inline-grid h-4 w-4 place-items-center rounded-full bg-rose-600 text-[10px] text-white">{i + 1}</span>
              {c.label}
            </button>
          ))}
          <button slot="ar-button" onClick={() => callbacks.current.onEvent?.('AR_START')} className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-rose-600 px-5 py-3 text-sm font-black text-white shadow-xl">
            <Smartphone className="h-5 w-5" /> Ver na minha mesa
          </button>
        </model-viewer>
      )}

      {state === 'loading' && (
        <div className="absolute inset-0 grid place-items-center text-slate-600">
          <span className="flex items-center gap-2 text-sm font-semibold"><Loader2 className="h-5 w-5 animate-spin" /> Carregando 3D…</span>
        </div>
      )}
      {state === 'error' && (
        <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-slate-600">
          Não foi possível abrir o 3D deste prato agora. Confira a internet e tente de novo.
        </div>
      )}

      {state === 'ready' && (
        <>
          <div className="pointer-events-none absolute left-2 top-2 rounded-lg bg-white/90 px-2 py-1 text-[11px] font-bold text-slate-800 shadow">
            Tamanho real · {formatArSize(model)}
          </div>
          {model.components.length > 0 && variant === 'customer' && (
            <button onClick={toggleExplode} className={`absolute right-2 top-2 flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-black shadow ${exploded ? 'bg-amber-400 text-slate-950' : 'bg-white/90 text-slate-800'}`}>
              <Layers className="h-4 w-4" /> {exploded ? 'Juntar' : 'Ver os itens'}
            </button>
          )}
          {!canAR && variant === 'customer' && (
            <div className="pointer-events-none absolute inset-x-2 bottom-2 flex items-center justify-center gap-1 rounded-lg bg-white/90 px-2 py-1.5 text-center text-[11px] font-semibold text-slate-700 shadow">
              <Move3d className="h-4 w-4 shrink-0" /> Arraste para girar. No celular aparece o botão “Ver na minha mesa”.
            </div>
          )}
        </>
      )}
    </div>
  );
}
