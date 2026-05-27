/* eslint-disable @typescript-eslint/no-explicit-any */

declare module 'react-reconciler' {
  export interface FiberRoot {}
  function createReconciler(config: any): any;
  export { createReconciler };
  export default createReconciler;
}

declare module 'react-reconciler/constants.js' {
  export const ConcurrentRoot: number;
  export const LegacyRoot: number;
  export const ContinuousEventPriority: number;
  export const DefaultEventPriority: number;
  export const DiscreteEventPriority: number;
  export const NoEventPriority: number;
}

declare module 'bidi-js' {
  interface BidiSegment {
    start: number;
    end: number;
    dir: string;
  }
  interface BidiResult {
    getReorderSegments(text: string, direction?: string): BidiSegment[];
    getReorderedString(text: string, direction?: string): string;
    getEmbeddingLevels(text: string, direction?: string): { levels: number[] };
  }
  const bidiFactory: (input?: any) => BidiResult;
  export = bidiFactory;
}
