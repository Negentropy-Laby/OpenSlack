import type { DOMElement } from './ink/dom.js';

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'ink-box': { style?: any; [key: string]: any };
      'ink-text': { style?: any; [key: string]: any };
      'ink-root': { [key: string]: any };
      'ink-virtual-text': { [key: string]: any };
    }
  }
}

declare module 'react/jsx-runtime' {
  namespace JSX {
    interface IntrinsicElements {
      'ink-box': { style?: any; [key: string]: any };
      'ink-text': { style?: any; [key: string]: any };
      'ink-root': { [key: string]: any };
      'ink-virtual-text': { [key: string]: any };
    }
  }
}
