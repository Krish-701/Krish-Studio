"use client";
import * as React from "react";
import { Brush, Eraser, Undo2, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Paint a white-on-black mask over a frame for inpainting (white = region to change). */
export function MaskEditor({ src, onSubmit, onCancel }: { src: string; onSubmit: (mask: Blob, prompt: string) => void; onCancel: () => void }) {
  const canvas = React.useRef<HTMLCanvasElement>(null);
  const img = React.useRef<HTMLImageElement>(null);
  const [size, setSize] = React.useState(40);
  const [erase, setErase] = React.useState(false);
  const [prompt, setPrompt] = React.useState("");
  const history = React.useRef<ImageData[]>([]);
  const drawing = React.useRef(false);

  const init = () => {
    const c = canvas.current!, i = img.current!;
    c.width = i.naturalWidth;
    c.height = i.naturalHeight;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, c.width, c.height);
  };

  const pos = (e: React.PointerEvent) => {
    const c = canvas.current!;
    const r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * c.width, y: ((e.clientY - r.top) / r.height) * c.height, scale: c.width / r.width };
  };

  const paint = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    const ctx = canvas.current!.getContext("2d")!;
    const p = pos(e);
    ctx.globalCompositeOperation = erase ? "destination-out" : "source-over";
    ctx.fillStyle = "rgba(245,165,36,0.55)";
    ctx.beginPath();
    ctx.arc(p.x, p.y, (size / 2) * p.scale, 0, Math.PI * 2);
    ctx.fill();
  };

  const exportMask = () =>
    new Promise<Blob>((resolve) => {
      const c = canvas.current!;
      const out = document.createElement("canvas");
      out.width = c.width;
      out.height = c.height;
      const o = out.getContext("2d")!;
      o.fillStyle = "#000";
      o.fillRect(0, 0, out.width, out.height);
      const data = c.getContext("2d")!.getImageData(0, 0, c.width, c.height);
      const m = o.getImageData(0, 0, out.width, out.height);
      for (let k = 0; k < data.data.length; k += 4) {
        if (data.data[k + 3] > 10) {
          m.data[k] = m.data[k + 1] = m.data[k + 2] = 255;
        }
      }
      o.putImageData(m, 0, 0);
      out.toBlob((b) => resolve(b!), "image/png");
    });

  return (
    <div className="space-y-3">
      <div className="relative overflow-hidden rounded-xl border border-line-2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img ref={img} src={src} alt="" className="block w-full select-none" onLoad={init} crossOrigin="anonymous" draggable={false} />
        <canvas
          ref={canvas}
          className="absolute inset-0 size-full cursor-crosshair touch-none"
          onPointerDown={(e) => {
            drawing.current = true;
            const c = canvas.current!;
            history.current.push(c.getContext("2d")!.getImageData(0, 0, c.width, c.height));
            (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
            paint(e);
          }}
          onPointerMove={paint}
          onPointerUp={() => (drawing.current = false)}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant={erase ? "ghost" : "secondary"} onClick={() => setErase(false)}><Brush /> Paint</Button>
        <Button size="sm" variant={erase ? "secondary" : "ghost"} onClick={() => setErase(true)}><Eraser /> Erase</Button>
        <Button size="sm" variant="ghost" onClick={() => { const h = history.current.pop(); if (h) canvas.current!.getContext("2d")!.putImageData(h, 0, 0); }}><Undo2 /> Undo</Button>
        <input type="range" min={8} max={160} value={size} onChange={(e) => setSize(+e.target.value)} className="w-28 accent-[#f5a524]" aria-label="Brush size" />
      </div>
      <div className="flex gap-2">
        <Input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="What should the painted area become?" />
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button disabled={!prompt.trim()} onClick={async () => onSubmit(await exportMask(), prompt)}><Wand2 /> Inpaint</Button>
      </div>
    </div>
  );
}
