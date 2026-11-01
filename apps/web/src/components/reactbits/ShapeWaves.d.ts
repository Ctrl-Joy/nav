// Types for the React Bits ShapeWaves component (ShapeWaves.jsx), which ships as plain JavaScript.
import type { JSX } from 'react';

export interface ShapeWavesProps {
  text?: string;
  fontFamily?: string;
  fontWeight?: string | number;
  textSize?: number;
  shapes?: 'mixed' | 'squares' | 'circles' | 'triangles';
  cellSize?: number;
  dotSize?: number;
  color?: string;
  hoverColor?: string;
  backgroundColor?: string;
  speed?: number;
  scale?: number;
  contrast?: number;
  brightness?: number;
  flow?: number;
  direction?: number;
  fade?: number;
  interactive?: boolean;
  splashRadius?: number;
  splashStrength?: number;
  glow?: number;
  intro?: boolean;
  introDuration?: number;
  introKey?: string | number;
  paused?: boolean;
  onError?: (error: Error) => void;
  className?: string;
}

export default function ShapeWaves(props: ShapeWavesProps): JSX.Element;
