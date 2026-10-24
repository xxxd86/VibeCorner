// state.js — 全局 store（发布订阅）。零依赖、无构建。
// 唯一可变状态入口：所有写操作走 setState，UI 通过 subscribe 订阅。

export const state = {
  sessions: [],
  session: null,
  busy: false,
  stage: 'empty',
  pickMode: false,
  panelOpen: false,
  theme: 'light',
};

const listeners = new Set();
let userGoal = '';

/**
 * 浅合并 + 通知订阅者。
 * 订阅者自身抛错不会阻断其它订阅者：异步重抛，交给 window.onerror → #dev-error-banner。
 * @param {object} patch
 * @returns {object} state
 */
export function setState(patch) {
  if (!patch || typeof patch !== 'object') return state;
  Object.assign(state, patch);
  listeners.forEach((fn) => {
    try {
      fn(state);
    } catch (err) {
      setTimeout(() => {
        throw err;
      }, 0);
    }
  });
  return state;
}

/**
 * @param {(s:object)=>void} fn
 * @returns {()=>void} unsubscribe
 */
export function subscribe(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 输入框草稿（不参与 store 通知，避免每次键入重渲染） */
export function getUserGoal() {
  return userGoal;
}

export function setUserGoal(v) {
  userGoal = String(v == null ? '' : v).slice(0, 500);
  return userGoal;
}
