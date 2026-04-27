let abortController = new AbortController();

export function getAbortSignal() {
  return abortController.signal;
}

export function refreshAbortController() {
  abortController.abort();
  abortController = new AbortController();
  return abortController;
}

export function abortActiveTasks() {
  abortController.abort();
}
