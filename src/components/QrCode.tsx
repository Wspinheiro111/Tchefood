import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

/** QR Code em SVG puro (funciona offline e imprime nítido na bobina). */
export function QrCode({ value, size = 160, className = '' }: { value: string; size?: number; className?: string }) {
  const path = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    const count = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (qr.isDark(r, c)) d += `M${c + 2},${r + 2}h1v1h-1z`;
      }
    }
    return { d, count };
  }, [value]);
  const box = path.count + 4;
  return (
    <svg
      role="img"
      aria-label="QR Code"
      viewBox={`0 0 ${box} ${box}`}
      width={size}
      height={size}
      className={className}
      shapeRendering="crispEdges"
    >
      <rect width={box} height={box} fill="#ffffff" />
      <path d={path.d} fill="#000000" />
    </svg>
  );
}
