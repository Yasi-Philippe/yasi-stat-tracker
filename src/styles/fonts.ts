/**
 * Bundled fonts (the app works offline). Only the Latin and Latin Extended
 * subsets are shipped, which covers English, Spanish, French, Portuguese…
 */

import frauncesExt from '@fontsource-variable/fraunces/files/fraunces-latin-ext-wght-normal.woff2?url';
import fraunces from '@fontsource-variable/fraunces/files/fraunces-latin-wght-normal.woff2?url';
import interExt from '@fontsource-variable/inter/files/inter-latin-ext-wght-normal.woff2?url';
import inter from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url';
import monoExt from '@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-ext-wght-normal.woff2?url';
import mono from '@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?url';
import manropeExt from '@fontsource-variable/manrope/files/manrope-latin-ext-wght-normal.woff2?url';
import manrope from '@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2?url';
import soraExt from '@fontsource-variable/sora/files/sora-latin-ext-wght-normal.woff2?url';
import sora from '@fontsource-variable/sora/files/sora-latin-wght-normal.woff2?url';
import groteskExt from '@fontsource-variable/space-grotesk/files/space-grotesk-latin-ext-wght-normal.woff2?url';
import grotesk from '@fontsource-variable/space-grotesk/files/space-grotesk-latin-wght-normal.woff2?url';
import serifItalicExt from '@fontsource/instrument-serif/files/instrument-serif-latin-ext-400-italic.woff2?url';
import serifItalic from '@fontsource/instrument-serif/files/instrument-serif-latin-400-italic.woff2?url';
import serifExt from '@fontsource/instrument-serif/files/instrument-serif-latin-ext-400-normal.woff2?url';
import serif from '@fontsource/instrument-serif/files/instrument-serif-latin-400-normal.woff2?url';

const LATIN =
  'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const LATIN_EXT =
  'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF';

interface Face {
  family: string;
  url: string;
  range: string;
  weight: string;
  style?: 'italic' | 'normal';
}

const faces: Face[] = [
  { family: 'Manrope Variable', url: manrope, range: LATIN, weight: '200 800' },
  { family: 'Manrope Variable', url: manropeExt, range: LATIN_EXT, weight: '200 800' },
  { family: 'Inter Variable', url: inter, range: LATIN, weight: '100 900' },
  { family: 'Inter Variable', url: interExt, range: LATIN_EXT, weight: '100 900' },
  { family: 'Sora Variable', url: sora, range: LATIN, weight: '100 800' },
  { family: 'Sora Variable', url: soraExt, range: LATIN_EXT, weight: '100 800' },
  { family: 'Space Grotesk Variable', url: grotesk, range: LATIN, weight: '300 700' },
  { family: 'Space Grotesk Variable', url: groteskExt, range: LATIN_EXT, weight: '300 700' },
  { family: 'Fraunces Variable', url: fraunces, range: LATIN, weight: '100 900' },
  { family: 'Fraunces Variable', url: frauncesExt, range: LATIN_EXT, weight: '100 900' },
  { family: 'JetBrains Mono Variable', url: mono, range: LATIN, weight: '100 800' },
  { family: 'JetBrains Mono Variable', url: monoExt, range: LATIN_EXT, weight: '100 800' },
  { family: 'Instrument Serif', url: serif, range: LATIN, weight: '400' },
  { family: 'Instrument Serif', url: serifExt, range: LATIN_EXT, weight: '400' },
  { family: 'Instrument Serif', url: serifItalic, range: LATIN, weight: '400', style: 'italic' },
  { family: 'Instrument Serif', url: serifItalicExt, range: LATIN_EXT, weight: '400', style: 'italic' },
];

export function installFonts(): void {
  const style = document.createElement('style');
  style.dataset.fonts = '';
  style.textContent = faces
    .map(
      (f) =>
        `@font-face{font-family:'${f.family}';font-style:${f.style ?? 'normal'};font-display:swap;font-weight:${f.weight};src:url(${f.url}) format('woff2');unicode-range:${f.range};}`,
    )
    .join('\n');
  document.head.appendChild(style);
}
