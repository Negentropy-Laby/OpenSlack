import { describe, it, expect } from 'vitest';
import React from 'react';
import {
  routerPush,
  routerPop,
  routerReplace,
  routerReset,
  createInitialRouterState,
  HOME_ROUTE,
} from '../navigation/router.js';
import type { Route, RouterState } from '../navigation/router.js';

describe('navigation router', () => {
  describe('createInitialRouterState', () => {
    it('returns state with home as current route', () => {
      const state = createInitialRouterState();
      expect(state.current.view).toBe('home');
      expect(state.stack).toHaveLength(1);
    });

    it('stack contains only HOME_ROUTE', () => {
      const state = createInitialRouterState();
      expect(state.stack[0]).toEqual(HOME_ROUTE);
    });
  });

  describe('routerPush', () => {
    it('adds route to stack and sets as current', () => {
      const state = createInitialRouterState();
      const route: Route = { view: 'dashboard' };
      const next = routerPush(state, route);
      expect(next.current).toEqual(route);
      expect(next.stack).toHaveLength(2);
      expect(next.stack[1]).toEqual(route);
    });

    it('preserves existing stack entries', () => {
      const state = createInitialRouterState();
      const route1: Route = { view: 'dashboard' };
      const route2: Route = { view: 'pr-queue' };
      const next1 = routerPush(state, route1);
      const next2 = routerPush(next1, route2);
      expect(next2.stack).toHaveLength(3);
      expect(next2.current).toEqual(route2);
    });

    it('supports routes with params', () => {
      const state = createInitialRouterState();
      const route: Route = { view: 'room', params: { ref: 'pr:42' } };
      const next = routerPush(state, route);
      expect(next.current.params).toEqual({ ref: 'pr:42' });
    });

    it('does not mutate the original state', () => {
      const state = createInitialRouterState();
      const originalStack = [...state.stack];
      routerPush(state, { view: 'status' });
      expect(state.stack).toEqual(originalStack);
    });
  });

  describe('routerPop', () => {
    it('removes the top route and sets current to previous', () => {
      const state = createInitialRouterState();
      const pushed = routerPush(state, { view: 'dashboard' });
      const popped = routerPop(pushed);
      expect(popped.current).toEqual(HOME_ROUTE);
      expect(popped.stack).toHaveLength(1);
    });

    it('does nothing when only home route remains', () => {
      const state = createInitialRouterState();
      const popped = routerPop(state);
      expect(popped.current).toEqual(HOME_ROUTE);
      expect(popped.stack).toHaveLength(1);
    });

    it('does not mutate the original state', () => {
      const state = routerPush(createInitialRouterState(), { view: 'dashboard' });
      const originalStack = [...state.stack];
      routerPop(state);
      expect(state.stack).toEqual(originalStack);
    });
  });

  describe('routerReplace', () => {
    it('replaces the current route with a new one', () => {
      const state = createInitialRouterState();
      const pushed = routerPush(state, { view: 'dashboard' });
      const replaced = routerReplace(pushed, { view: 'status' });
      expect(replaced.current.view).toBe('status');
      expect(replaced.stack).toHaveLength(2);
      expect(replaced.stack[1].view).toBe('status');
    });

    it('replaces home route when stack has only one entry', () => {
      const state = createInitialRouterState();
      const replaced = routerReplace(state, { view: 'dashboard' });
      expect(replaced.current.view).toBe('dashboard');
      expect(replaced.stack).toHaveLength(1);
    });
  });

  describe('routerReset', () => {
    it('resets to home route regardless of stack depth', () => {
      let state = createInitialRouterState();
      state = routerPush(state, { view: 'dashboard' });
      state = routerPush(state, { view: 'pr-queue' });
      state = routerPush(state, { view: 'status' });
      expect(state.stack).toHaveLength(4);

      const reset = routerReset(state);
      expect(reset.current).toEqual(HOME_ROUTE);
      expect(reset.stack).toHaveLength(1);
    });
  });
});

describe('HOME_ROUTE', () => {
  it('has view "home"', () => {
    expect(HOME_ROUTE.view).toBe('home');
  });

  it('has no params', () => {
    expect(HOME_ROUTE.params).toBeUndefined();
  });
});
