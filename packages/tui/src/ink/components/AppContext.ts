import { createContext, type Context } from 'react';

export type Props = {
  /**
   * Exit (unmount) the whole Ink app.
   */
  readonly exit: (error?: Error) => void;
};

/**
 * `AppContext` is a React context, which exposes a method to manually exit the app (unmount).
 */
const AppContext = createContext<Props>({
  exit() {},
});

(AppContext as Context<Props> & { displayName?: string }).displayName = 'InternalAppContext';

export default AppContext;
