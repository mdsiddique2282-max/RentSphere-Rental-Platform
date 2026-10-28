export const TOAST_DURATION = 3500;

export function createToastStore() {
  let current = null, timer;
  const listeners = new Set();
  const emit = () => listeners.forEach(listener => listener());
  const dismiss = () => {
    clearTimeout(timer); timer = undefined;
    if (current) { current = null; emit(); }
  };
  return {
    getSnapshot: () => current,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    show(message, type = 'success') {
      if (current?.message === message && current.type === type) return;
      clearTimeout(timer);
      current = { message, type }; emit();
      timer = setTimeout(dismiss, TOAST_DURATION);
    },
    dismiss,
  };
}

// Outside the route tree: a navigation cannot unmount or clear a notification.
export const toastStore = createToastStore();
export const notifyToast = (message, type) => toastStore.show(message, type);
