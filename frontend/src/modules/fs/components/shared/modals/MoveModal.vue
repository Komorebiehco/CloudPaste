<template>
  <Teleport to="body">
    <div v-if="isOpen" class="fixed inset-0 z-[65] flex items-center justify-center bg-black/50 p-3">
      <section ref="dialogElement" role="dialog" aria-modal="true" aria-labelledby="move-dialog-title" tabindex="-1" @keydown="handleKeydown"
        class="flex max-h-[90dvh] w-full max-w-lg flex-col overflow-hidden rounded-xl border shadow-xl"
        :class="darkMode ? 'border-gray-700 bg-gray-800 text-gray-100' : 'border-gray-200 bg-white text-gray-900'">
        <header class="flex items-center justify-between border-b p-4" :class="darkMode ? 'border-gray-700' : 'border-gray-200'">
          <h3 id="move-dialog-title" class="text-lg font-semibold">{{ t("mount.moveModal.title") }}</h3>
          <button type="button" :aria-label="t('common.close')" :disabled="moving" class="rounded p-1 disabled:opacity-40" @click="close"><IconClose /></button>
        </header>
        <div class="min-h-0 overflow-y-auto p-4">
          <p class="text-sm">{{ t("mount.moveModal.selected", { count: selectedItems.length }) }}</p>
          <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">{{ t("mount.moveModal.hint") }}</p>
          <div class="mt-4 flex items-center gap-2">
            <button type="button" class="shrink-0 rounded border p-2 disabled:opacity-40" :disabled="moving || loading || currentPath === basicPath" :title="t('mount.moveModal.parent')" @click="loadDirectory(parentPath(currentPath))"><IconArrowUp size="sm" /></button>
            <form class="flex min-w-0 flex-1 gap-2" @submit.prevent="loadDirectory(pathInput)">
              <input ref="pathElement" v-model="pathInput" :aria-label="t('mount.moveModal.target')" :disabled="moving || loading" class="min-w-0 flex-1 rounded border bg-transparent px-2 py-2 text-sm" />
              <button type="submit" :disabled="moving || loading" class="shrink-0 rounded border px-3 text-sm disabled:opacity-40">{{ t("mount.moveModal.go") }}</button>
            </form>
          </div>
          <div class="mt-3 h-56 overflow-y-auto rounded-lg border" :class="darkMode ? 'border-gray-700' : 'border-gray-200'">
            <p v-if="loading" class="p-4 text-sm">{{ t("common.loading") }}</p>
            <template v-else>
              <button v-for="folder in folders" :key="folder.path" type="button"
                :disabled="moving || excludedDirectory(folder.path)"
                class="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-gray-700"
                @click="loadDirectory(folder.path)">
                <IconFolder size="sm" class="shrink-0 text-yellow-500" />
                <span class="min-w-0 flex-1 truncate">{{ folder.name }}</span>
                <IconChevronRight size="sm" class="shrink-0" />
              </button>
              <p v-if="!folders.length && !loadError" class="p-4 text-sm text-gray-500">{{ t("mount.moveModal.empty") }}</p>
            </template>
          </div>
          <p class="mt-3 break-all text-sm"><span class="font-medium">{{ t("mount.moveModal.target") }}：</span>{{ currentPath }}</p>
          <p v-if="loadError || destinationWarning" role="alert" class="mt-2 text-sm text-amber-700 dark:text-amber-400">{{ loadError || destinationWarning }}</p>
          <p v-if="moving" role="status" class="mt-3 text-sm">{{ t("mount.moveModal.progress", { done: results.length, total: selectedItems.length }) }}</p>
          <div v-if="completed" role="status" class="mt-3 rounded-lg bg-gray-100 p-3 text-sm dark:bg-gray-700">
            {{ t("mount.moveModal.result", { success: successCount, failed: results.length - successCount }) }}
            <ul v-if="results.some(item => !item.success)" class="mt-2 max-h-32 space-y-1 overflow-y-auto">
              <li v-for="item in results.filter(item => !item.success)" :key="item.path" class="break-words text-red-600 dark:text-red-300">{{ item.name }}：{{ item.message }}</li>
            </ul>
          </div>
        </div>
        <footer class="flex shrink-0 justify-end gap-3 border-t p-4" :class="darkMode ? 'border-gray-700' : 'border-gray-200'">
          <button type="button" :disabled="moving" class="rounded-lg border px-4 py-2 text-sm disabled:opacity-40" @click="close">{{ completed ? t("common.close") : t("mount.cancel") }}</button>
          <button v-if="!completed" type="button" :disabled="moving || loading || !!loadError || !!destinationWarning || !selectedItems.length"
            class="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
            @click="confirmMove">{{ t("mount.moveModal.confirm") }}</button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<script setup>
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useFsService } from "@/modules/fs";
import { normalizeFsPath, isSameOrSubPath } from "@/utils/fsPathUtils.js";
import { IconArrowUp, IconChevronRight, IconClose, IconFolder } from "@/components/icons";

const props = defineProps({
  isOpen: Boolean,
  darkMode: Boolean,
  selectedItems: { type: Array, default: () => [] },
  sourcePath: { type: String, default: "/" },
  basicPath: { type: String, default: "/" },
});
const emit = defineEmits(["close", "moved"]);
const { t } = useI18n();
const fs = useFsService();
const dialogElement = ref(null);
const pathElement = ref(null);
let previousFocus = null;
const basicPath = computed(() => normalizeFsPath(props.basicPath));
const currentPath = ref("/");
const pathInput = ref("/");
const folders = ref([]);
const mountId = ref(null);
const loading = ref(false);
const loadError = ref("");
const moving = ref(false);
const completed = ref(false);
const results = ref([]);
const successCount = computed(() => results.value.filter(item => item.success).length);
const parentPath = path => normalizeFsPath(normalizeFsPath(path).split("/").slice(0, -1).join("/"));
const excludedDirectory = path => props.selectedItems.some(item => item.isDirectory && isSameOrSubPath(item.path, path));
const destinationWarning = computed(() => {
  if (!mountId.value) return t("mount.moveModal.selectMount");
  if (props.selectedItems.some(item => item.mount_id && String(item.mount_id) !== String(mountId.value))) return t("mount.moveModal.sameMount");
  if (excludedDirectory(currentPath.value)) return t("mount.moveModal.descendant");
  if (props.selectedItems.some(item => parentPath(item.path) === currentPath.value)) return t("mount.moveModal.sameDirectory");
  return "";
});

let requestVersion = 0;
async function loadDirectory(path) {
  if (moving.value) return;
  const nextPath = normalizeFsPath(path);
  if (!isSameOrSubPath(basicPath.value, nextPath) || nextPath.split("/").some(p => p === "." || p === "..")) {
    loadError.value = t("mount.moveModal.invalidPath");
    return;
  }
  const version = ++requestVersion;
  loading.value = true;
  loadError.value = "";
  try {
    let cursor = null;
    const directories = [];
    const seen = new Set();
    let data;
    do {
      data = await fs.getDirectoryList(nextPath, { refresh: true, cursor });
      if (version !== requestVersion || !props.isOpen) return;
      if (!data) throw new Error(t("mount.moveModal.loadFailed"));
      directories.push(...(data.items || []).filter(item => item.isDirectory));
      cursor = data.nextCursor || null;
      if (cursor && seen.has(cursor)) throw new Error(t("mount.moveModal.loadFailed"));
      if (cursor) seen.add(cursor);
    } while (cursor);
    currentPath.value = nextPath;
    pathInput.value = nextPath;
    mountId.value = data.mount_id || null;
    folders.value = directories;
  } catch (error) {
    if (version === requestVersion) loadError.value = error.message || t("mount.moveModal.loadFailed");
  } finally {
    if (version === requestVersion) loading.value = false;
  }
}

async function confirmMove() {
  if (moving.value || completed.value || destinationWarning.value || loading.value || loadError.value) return;
  moving.value = true;
  dialogElement.value?.focus();
  results.value = [];
  const items = props.selectedItems.map(item => ({ ...item }));
  const destination = currentPath.value;
  try {
    // Serial requests provide per-item results without replaying unknown writes.
    for (const item of items) {
      try {
        await fs.moveItem(item.path, destination);
        results.value.push({ path: item.path, name: item.name, success: true });
      } catch (error) {
        const unknown = !error.status || error.status >= 500;
        results.value.push({
          path: item.path, name: item.name, success: false,
          message: unknown ? t("mount.moveModal.unknown") : error.message,
        });
        if (unknown) {
          for (const remaining of items.slice(results.value.length)) {
            results.value.push({ path: remaining.path, name: remaining.name, success: false, message: t("mount.moveModal.notAttempted") });
          }
          break;
        }
      }
    }
  } finally {
    moving.value = false;
    completed.value = true;
    emit("moved", { results: results.value, targetPath: destination });
  }
}

function close() {
  if (moving.value) return;
  requestVersion++;
  fs.cancelAllRequests();
  emit("close");
  nextTick(() => { if (previousFocus?.isConnected) previousFocus.focus(); });
}

function handleKeydown(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    close();
  } else if (event.key === "Tab") {
    const controls = [...dialogElement.value.querySelectorAll("button:not(:disabled), input:not(:disabled), [tabindex='0']")]
      .filter(element => element.offsetParent !== null);
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (!first) {
      event.preventDefault();
      dialogElement.value.focus();
    } else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogElement.value)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
}

watch(() => props.isOpen, async open => {
  if (!open) return;
  previousFocus = document.activeElement;
  completed.value = false;
  results.value = [];
  mountId.value = null;
  folders.value = [];
  await nextTick();
  dialogElement.value?.focus();
  await loadDirectory(props.sourcePath);
  await nextTick();
  if (props.isOpen) pathElement.value?.focus();
}, { immediate: true });
</script>
