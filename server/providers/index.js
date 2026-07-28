/**
 * One face over the label sources, so nothing upstream has to know which one is
 * configured.
 *
 * Two questions are answered here and they are deliberately independent:
 *
 *   the index    which labels exist, and what each one is called and links to
 *   the folder   where that label's files are on this disk
 *
 * Folders always come from the filesystem, whatever the index is. Someone whose
 * label list arrives from an API still has those files sitting in a synced
 * folder locally, and pretending otherwise would mean the index owed us a path
 * it has no way to know.
 */

import { config, labelsEnabled } from '../config.js';
import { folderIndex, foldersStatus, labelFolder, labelFolders } from './folders.js';
import { commandIndex, commandStatus, refreshLabels as refreshCommand } from './command.js';

export { labelFolder, labelFolders };

function index() {
  if (!labelsEnabled()) return {};
  return config.labels.index === 'command' ? commandIndex() : folderIndex();
}

export function refreshLabels(opts) {
  if (config.labels.index === 'command') refreshCommand(opts);
}

/** Every label key, for matching text against things that actually exist. */
export function knownLabelKeys() {
  return Object.keys(index());
}

/** The full index — key -> { name, url, status, folder }. */
export function knownLabels() {
  return index();
}

/** True when this is a label the index actually has, so a guess can be refused. */
export function isKnownLabel(key) {
  return Boolean(key && Object.hasOwn(index(), key));
}

/** Deep link into whatever system supplied the label, or null. */
export function labelUrl(key) {
  if (!key) return null;
  return index()[key]?.url ?? null;
}

/** Human name for a label, falling back to the key itself. */
export function labelName(key) {
  if (!key) return null;
  return index()[key]?.name ?? key;
}

export function labelsStatus() {
  return {
    enabled: labelsEnabled(),
    index: config.labels.index,
    noun: config.labels.noun,
    count: knownLabelKeys().length,
    folders: foldersStatus(),
    source: config.labels.index === 'command' ? commandStatus() : null,
  };
}
