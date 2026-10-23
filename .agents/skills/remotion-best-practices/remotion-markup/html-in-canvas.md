# Using `<HtmlInCanvas>` in Remotion

Renders children into a `<canvas>` so you can post-process them with the Canvas 2D API or WebGL.

Only works in Chrome 149+ with the `chrome://flags/#canvas-draw-element` flag enabled.  
Give the user a notice.

## Nesting

Do not nest `<HtmlInCanvas>` components. Remotion rejects nesting because Chrome does not reliably render nested HTML-in-canvas subtrees.

## Enabling WebGL during renders

If you make use of WebGL during renders, you need to enable it:

From the CLI:

```bash
npx remotion render --gl=angle
```

Set it as the default for Studio and CLI (advised):

```ts
import { Config } from "@remotion/cli/config";

Config.setChromiumOpenGlRenderer("angle");
```

## Basic usage

By default, draws to canvas with no effect applied:

```tsx
import { HtmlInCanvas } from "remotion";

export const MyComp = () => {
  return (
    <HtmlInCanvas width={1280} height={720}>
      <div style={{ fontSize: 80 }}>
        Hello
      </div>
    </HtmlInCanvas>
  );
};
```

## 2D effect with `onPaint`

`onPaint` runs whenever the content updates. Call `ctx.drawElementImage(elementImage, 0, 0)` to draw the captured DOM, and assign the returned transform to `element.style.transform` so DOM selection still aligns with the painted output.

```tsx
import {
  AbsoluteFill,
  HtmlInCanvas,
  type HtmlInCanvasOnPaint,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { useCallback } from "react";

export const Blur = () => {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();

  const onPaint: HtmlInCanvasOnPaint = useCallback(
    ({ canvas, element, elementImage }) => {
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Failed to acquire 2D context");

      const blurPx = 4 + 18 * (0.5 + 0.5 * Math.sin((frame / fps) * Math.PI));

      ctx.reset();
      ctx.filter = `blur(${blurPx}px)`;
      const transform = ctx.drawElementImage(elementImage, 0, 0);
      element.style.transform = transform.toString();
    },
    [frame, fps],
  );

  return (
    <HtmlInCanvas width={width} height={height} onPaint={onPaint}>
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          fontSize: 120,
        }}
      >
        <h1>
          Hello
        </h1>
      </AbsoluteFill>
    </HtmlInCanvas>
  );
};
```

## WebGL effects

For WebGL, set up the context, program, and texture in `onInit` and return a cleanup function. Inside `onPaint`, upload the captured DOM with `gl.texElementImage2D(...)` and draw.

`onInit` and `onPaint` do not share a scope, so keep the context in a ref, and pass both callbacks to `<HtmlInCanvas>`:

```tsx
import { useCallback, useRef } from "react";
import {
  AbsoluteFill,
  HtmlInCanvas,
  type HtmlInCanvasOnInit,
  type HtmlInCanvasOnPaint,
  useVideoConfig,
} from "remotion";

export const WebGLEffect = () => {
  const { width, height } = useVideoConfig();
  const glRef = useRef<WebGL2RenderingContext | null>(null);

  const onInit: HtmlInCanvasOnInit = useCallback(({ canvas }) => {
    const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true });
    if (!gl) {
      throw new Error(
        "WebGL2 unavailable. Try rendering with the --gl=angle option. See https://remotion.dev/docs/gl-options.",
      );
    }
    glRef.current = gl;
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    // compile program, create texture, set up VAO...
    return () => {
      // delete program, texture, buffers...
      glRef.current = null;
    };
  }, []);

  const onPaint: HtmlInCanvasOnPaint = useCallback(({ elementImage }) => {
    const gl = glRef.current;
    if (!gl) return;
    gl.texElementImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, elementImage);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }, []);

  return (
    <HtmlInCanvas width={width} height={height} onInit={onInit} onPaint={onPaint}>
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", fontSize: 120 }}>
        <h1>Hello</h1>
      </AbsoluteFill>
    </HtmlInCanvas>
  );
};
```

For a fully working minimal example, see https://github.com/remotion-dev/remotion/blob/main/packages/docs/components/demos/HtmlInCanvasDocsDemoWebGL.tsx.

## Async `onPaint`

`onPaint` may be `async`. Remotion holds the frame open via `delayRender()` until the promise resolves. Useful for multi-pass effects with `createImageBitmap`.
