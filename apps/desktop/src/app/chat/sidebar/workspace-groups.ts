import type { HermesGitWorktree, HermesWorktreeInfo } from '@/global'
import type { DiscoveredRepo, ProjectInfo, SessionInfo } from '@/hermes'

export interface SidebarSessionGroup {
  id: string
  label: string
  path: null | string
  sessions: SessionInfo[]
  // Profile color for the ALL-profiles view; absent for workspace groups.
  color?: null | string
  // True when this group is a repo's main checkout (vs a linked worktree).
  isMain?: boolean
  // True for the synthetic lane that collapses all of a repo's kanban task
  // worktrees (`<repo>/.worktrees/t_*`) into one row, so a heavy board doesn't
  // spray hundreds of throwaway branch lanes across the sidebar.
  isKanban?: boolean
  loadingMore?: boolean
  mode?: 'profile' | 'source' | 'workspace'
  onLoadMore?: () => void
  sourceId?: string
  totalCount?: number
}

const NO_WORKSPACE_ID = '__no_workspace__'

/** Path split into segments, ignoring trailing slashes and mixed separators. */
const segments = (path: string): string[] => path.replace(/[/\\]+$/, '').split(/[/\\]/).filter(Boolean)

/** Last path segment. */
export const baseName = (path: string): string | undefined => segments(path).pop()

/** The segments above the basename. */
const parentSegments = (path: string): string[] => segments(path).slice(0, -1)

interface Labelable {
  id: string
  label: string
  path: null | string
}

/**
 * Disambiguate groups whose basename collides (worktrees all end in the same
 * `apps/desktop`, sibling repos share a folder name, etc.) by walking up the
 * path and prepending parent segments until each colliding label is unique —
 * e.g. `hermes-agent/desktop` vs `hermes-agent-wt-rtl/desktop`. Groups with a
 * unique basename keep their short label untouched.
 */
function disambiguateLabels(groups: Labelable[]): void {
  const byLabel = new Map<string, Labelable[]>()

  for (const group of groups) {
    const bucket = byLabel.get(group.label)

    if (bucket) {
      bucket.push(group)
    } else {
      byLabel.set(group.label, [group])
    }
  }

  for (const bucket of byLabel.values()) {
    if (bucket.length < 2) {
      continue
    }

    // Only groups backed by a real path can grow a prefix; the synthetic
    // "No workspace" group has no path and stays as-is.
    const pathed = bucket.filter(group => group.path)

    if (pathed.length < 2) {
      continue
    }

    const parents = new Map(pathed.map(group => [group.id, parentSegments(group.path!)]))
    let depth = 1

    // Grow the prefix one parent segment at a time until every label in the
    // bucket is distinct, or we run out of parent segments to add.
    while (depth <= Math.max(...pathed.map(g => parents.get(g.id)!.length))) {
      const labels = new Map<string, number>()

      for (const group of pathed) {
        const segs = parents.get(group.id)!
        const prefix = segs.slice(-depth).join('/')
        const base = baseName(group.path!) ?? group.path!
        group.label = prefix ? `${prefix}/${base}` : base
        labels.set(group.label, (labels.get(group.label) ?? 0) + 1)
      }

      if ([...labels.values()].every(count => count === 1)) {
        break
      }

      depth += 1
    }
  }
}

export function workspaceGroupsFor(
  sessions: SessionInfo[],
  noWorkspaceLabel: string,
  options: { preserveSessionOrder?: boolean } = {}
): SidebarSessionGroup[] {
  const groups = new Map<string, SidebarSessionGroup>()

  for (const session of sessions) {
    const path = session.cwd?.trim() || ''
    const id = path || NO_WORKSPACE_ID
    const label = baseName(path) || path || noWorkspaceLabel

    const group = groups.get(id) ?? { id, label, path: path || null, sessions: [] }
    group.sessions.push(session)
    groups.set(id, group)
  }

  if (!options.preserveSessionOrder) {
    // Groups keep recency order (Map insertion = first-seen in the recency-sorted
    // input, so an active project floats up), but rows *within* a group sort by
    // creation time so they don't reshuffle every time a message lands — keeps
    // muscle memory intact.
    for (const group of groups.values()) {
      group.sessions.sort((a, b) => b.started_at - a.started_at)
    }
  }

  const result = [...groups.values()]
  disambiguateLabels(result)

  return result
}

/**
 * A worktree's main repo and all its linked worktrees collapse into ONE parent
 * (keyed by the repo root); each worktree is a child group; sessions hang off
 * the worktree they ran in. `parent → worktree → sessions`.
 */
export interface SidebarWorkspaceTree {
  id: string
  label: string
  path: null | string
  groups: SidebarSessionGroup[]
  sessionCount: number
}

/** Resolves a session cwd to git-worktree identity (from the local fs probe). */
export type WorktreeResolver = (cwd: string) => HermesWorktreeInfo | null | undefined

interface WorkspacePlacement {
  parentKey: string
  parentLabel: string
  parentPath: string
  worktreeKey: string
  worktreeLabel: string
  worktreePath: string
  // True when this group lives in the repo's MAIN checkout directory (vs a
  // linked worktree). The main checkout is never `git worktree remove`-able, and
  // its sessions split into per-branch groups (below). Linked worktrees are
  // per-branch by construction and removable.
  isMain: boolean
  isKanban?: boolean
}

/** The kanban-task worktree dir (`<repo>/.worktrees`) for a `…/.worktrees/<task>` path, else null. */
const KANBAN_DIR_RE = /^(.*[/\\]\.worktrees)[/\\][^/\\]+[/\\]?$/

export function kanbanWorktreeDir(path: string): null | string {
  return path.match(KANBAN_DIR_RE)?.[1] ?? null
}

/** Default-branch names that sort first and read as the repo's trunk. */
const TRUNK_BRANCHES = new Set(['main', 'master', 'trunk', 'develop'])

function compareWorktreeGroups(a: SidebarSessionGroup, b: SidebarSessionGroup): number {
  if (Boolean(a.isMain) !== Boolean(b.isMain)) {
    return a.isMain ? -1 : 1
  }

  if (a.isMain && b.isMain) {
    const aTrunk = TRUNK_BRANCHES.has(a.label.toLowerCase())
    const bTrunk = TRUNK_BRANCHES.has(b.label.toLowerCase())

    if (aTrunk !== bTrunk) {
      return aTrunk ? -1 : 1
    }
  }

  // The collapsed kanban bucket sinks below real branches.
  if (Boolean(a.isKanban) !== Boolean(b.isKanban)) {
    return a.isKanban ? 1 : -1
  }

  return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })
}

export function sortWorktreeGroups(groups: SidebarSessionGroup[]): SidebarSessionGroup[] {
  return [...groups].sort(compareWorktreeGroups)
}

/** Replace a path's final segment, preserving its prefix + separators. */
const withBaseName = (path: string, name: string): string =>
  path.replace(/[/\\]+$/, '').replace(/[^/\\]+$/, name)

/**
 * Path-only fallback for when git metadata is unavailable (remote backends,
 * unreadable paths). Mirrors the git layout: a `<repo>-wt-<branch>` directory
 * nests under its sibling `<repo>`; any other directory is its own repo root.
 */
function placeByHeuristic(path: string): WorkspacePlacement | null {
  const base = baseName(path)

  if (!base) {
    return null
  }

  // Git probe failed but the path still betrays a kanban task worktree; collapse
  // it onto its repo (the dir above `.worktrees`) like the git-backed branch does.
  const kanbanDir = kanbanWorktreeDir(path)

  if (kanbanDir) {
    const repoPath = withBaseName(kanbanDir, '').replace(/[/\\]+$/, '')

    return {
      parentKey: repoPath,
      parentLabel: baseName(repoPath) ?? repoPath,
      parentPath: repoPath,
      worktreeKey: `${repoPath}::kanban`,
      worktreeLabel: 'kanban',
      worktreePath: kanbanDir,
      isMain: false,
      isKanban: true
    }
  }

  const worktreeMatch = base.match(/^(.+)-wt-(.+)$/)

  if (worktreeMatch) {
    const repo = worktreeMatch[1]
    const repoPath = withBaseName(path, repo)

    return {
      parentKey: repoPath,
      parentLabel: repo,
      parentPath: repoPath,
      worktreeKey: path,
      worktreeLabel: worktreeMatch[2],
      worktreePath: path,
      isMain: false
    }
  }

  return {
    parentKey: path,
    parentLabel: base,
    parentPath: path,
    worktreeKey: path,
    worktreeLabel: base,
    worktreePath: path,
    isMain: true
  }
}

function placeWorkspace(
  path: string,
  sessionBranch: string,
  resolver?: WorktreeResolver,
  persistedRoot = ''
): WorkspacePlacement | null {
  const info = resolver?.(path)

  if (info?.repoRoot && info.worktreeRoot) {
    const dirLabel = baseName(info.worktreeRoot) || info.worktreeRoot

    if (info.isMainWorktree) {
      // Split the main checkout by the branch each session recorded at run time
      // (session.git_branch — the true history). We deliberately do NOT fall
      // back to the repo's *current* branch for unrecorded sessions: git only
      // knows what's checked out now, not what was checked out when an old
      // session ran, so that fallback misattributes every legacy session to the
      // current branch. Unknown-branch sessions collapse into a neutral "main"
      // bucket instead of claiming a branch we can't prove.
      const branch = sessionBranch.trim()

      return {
        parentKey: info.repoRoot,
        parentLabel: baseName(info.repoRoot) ?? info.repoRoot,
        parentPath: info.repoRoot,
        worktreeKey: branch ? `${info.repoRoot}::branch::${branch}` : `${info.repoRoot}::branch::`,
        worktreeLabel: branch || 'main',
        worktreePath: info.worktreeRoot,
        isMain: true
      }
    }

    const kanbanDir = kanbanWorktreeDir(info.worktreeRoot)

    if (kanbanDir) {
      // Every `<repo>/.worktrees/t_*` task folds into one "kanban" lane keyed on
      // the repo. worktreePath is the shared `.worktrees` dir, so a single
      // cwd-prefix query hydrates all task sessions at once.
      return {
        parentKey: info.repoRoot,
        parentLabel: baseName(info.repoRoot) ?? info.repoRoot,
        parentPath: info.repoRoot,
        worktreeKey: `${info.repoRoot}::kanban`,
        worktreeLabel: 'kanban',
        worktreePath: kanbanDir,
        isMain: false,
        isKanban: true
      }
    }

    return {
      parentKey: info.repoRoot,
      parentLabel: baseName(info.repoRoot) ?? info.repoRoot,
      parentPath: info.repoRoot,
      worktreeKey: info.worktreeRoot,
      // Linked worktrees are per-branch by construction, so branch is the
      // clearest label there.
      worktreeLabel: info.branch || dirLabel,
      worktreePath: info.worktreeRoot,
      isMain: false
    }
  }

  // No live git probe (remote backend, or not-yet-probed): fall back to the
  // backend-persisted repo root. This is the authoritative key — group by it,
  // splitting the main checkout by the session's recorded branch (kanban tasks
  // still collapse). Only when there's no persisted root do we guess by path.
  if (persistedRoot) {
    const kanbanDir = kanbanWorktreeDir(path)

    if (kanbanDir) {
      return {
        parentKey: persistedRoot,
        parentLabel: baseName(persistedRoot) ?? persistedRoot,
        parentPath: persistedRoot,
        worktreeKey: `${persistedRoot}::kanban`,
        worktreeLabel: 'kanban',
        worktreePath: kanbanDir,
        isMain: false,
        isKanban: true
      }
    }

    const branch = sessionBranch.trim()

    return {
      parentKey: persistedRoot,
      parentLabel: baseName(persistedRoot) ?? persistedRoot,
      parentPath: persistedRoot,
      worktreeKey: branch ? `${persistedRoot}::branch::${branch}` : `${persistedRoot}::branch::`,
      worktreeLabel: branch || 'main',
      worktreePath: persistedRoot,
      isMain: true
    }
  }

  return placeByHeuristic(path)
}

/** Unique, non-empty session cwds — the batch to probe for worktree info. */
export function uniqueCwds(sessions: SessionInfo[]): string[] {
  const seen = new Set<string>()

  for (const session of sessions) {
    const path = session.cwd?.trim()

    if (path) {
      seen.add(path)
    }
  }

  return [...seen]
}

/**
 * Build the `parent → worktree → sessions` tree. Parents keep recency order
 * (first-seen in the recency-sorted input); worktree groups within a parent do
 * too, while rows inside a worktree sort by creation time (stable muscle memory,
 * matching `workspaceGroupsFor`).
 */
export function workspaceTreeFor(
  sessions: SessionInfo[],
  noWorkspaceLabel: string,
  resolver?: WorktreeResolver,
  options: { preserveSessionOrder?: boolean } = {}
): SidebarWorkspaceTree[] {
  interface WorktreeEntry {
    group: SidebarSessionGroup
    parentKey: string
    parentLabel: string
    parentPath: string
  }

  const worktrees = new Map<string, WorktreeEntry>()
  const noWorkspace: SessionInfo[] = []

  for (const session of sessions) {
    const path = session.cwd?.trim() || ''

    if (!path) {
      noWorkspace.push(session)

      continue
    }

    const placement = placeWorkspace(
      path,
      session.git_branch?.trim() || '',
      resolver,
      (session.git_repo_root || '').trim()
    )

    if (!placement) {
      noWorkspace.push(session)

      continue
    }

    let entry = worktrees.get(placement.worktreeKey)

    if (!entry) {
      entry = {
        group: {
          id: placement.worktreeKey,
          label: placement.worktreeLabel,
          path: placement.worktreePath,
          isMain: placement.isMain,
          isKanban: placement.isKanban,
          sessions: []
        },
        parentKey: placement.parentKey,
        parentLabel: placement.parentLabel,
        parentPath: placement.parentPath
      }
      worktrees.set(placement.worktreeKey, entry)
    }

    entry.group.sessions.push(session)
  }

  if (!options.preserveSessionOrder) {
    for (const entry of worktrees.values()) {
      entry.group.sessions.sort((a, b) => b.started_at - a.started_at)
    }
  }

  const parents = new Map<string, SidebarWorkspaceTree>()

  for (const entry of worktrees.values()) {
    let parent = parents.get(entry.parentKey)

    if (!parent) {
      parent = { id: entry.parentKey, label: entry.parentLabel, path: entry.parentPath, groups: [], sessionCount: 0 }
      parents.set(entry.parentKey, parent)
    }

    parent.groups.push(entry.group)
    parent.sessionCount += entry.group.sessions.length
  }

  // Order groups within a repo: main-checkout branches first (trunk like
  // main/master ahead of feature branches, then alphabetical), then linked
  // worktrees. Keeps the trunk pinned to the top regardless of activity.
  for (const parent of parents.values()) {
    parent.groups = sortWorktreeGroups(parent.groups)
  }

  const result = [...parents.values()]

  if (noWorkspace.length) {
    result.push({
      id: NO_WORKSPACE_ID,
      label: noWorkspaceLabel,
      path: null,
      groups: [{ id: NO_WORKSPACE_ID, label: noWorkspaceLabel, path: null, sessions: noWorkspace }],
      sessionCount: noWorkspace.length
    })
  }

  // Parents that collide on basename grow a path prefix; worktree labels that
  // collide inside a parent do the same.
  disambiguateLabels(result)

  for (const parent of result) {
    disambiguateLabels(parent.groups)
  }

  return result
}

// ── Project-level grouping ───────────────────────────────────────────────────
// A Project is a human-named, persisted, multi-folder workspace. It is the new
// outermost grouping level: sessions belong to a project when their cwd lives
// under one of the project's folders. Inside a project the existing
// repo -> worktree -> sessions tree is preserved, so a project that contains a
// git repo still shows its worktrees/branches.

export const NO_PROJECT_ID = '__no_project__'

/** True when `target` equals `folder` or is nested under it (segment-wise). */
function isPathUnder(folder: string, target: string): boolean {
  const f = segments(folder)
  const t = segments(target)

  if (f.length === 0 || f.length > t.length) {
    return false
  }

  for (let i = 0; i < f.length; i += 1) {
    if (f[i] !== t[i]) {
      return false
    }
  }

  return true
}

/**
 * Resolve which (non-archived) project owns `cwd` by longest-prefix folder
 * match — the most specific folder wins, so nested projects resolve to the
 * innermost one. Mirrors the backend `projects_db.project_for_path`.
 */
export function projectForPath(projects: ProjectInfo[], cwd: string): ProjectInfo | null {
  const target = (cwd || '').trim()

  if (!target) {
    return null
  }

  let best: ProjectInfo | null = null
  let bestLen = -1

  for (const project of projects) {
    if (project.archived) {
      continue
    }

    for (const folder of project.folders) {
      if (isPathUnder(folder.path, target)) {
        const len = segments(folder.path).length

        if (len > bestLen) {
          bestLen = len
          best = project
        }
      }
    }
  }

  return best
}

/** Longest-prefix project match against cwd and, when known, its git repoRoot. */
/** The repo a session belongs to: the backend-persisted root wins; the local
 *  git probe is only a fallback for rows not yet backfilled. */
export function sessionRepoRoot(session: SessionInfo, resolver?: WorktreeResolver): string {
  const persisted = (session.git_repo_root || '').trim()

  if (persisted) {
    return persisted
  }

  const cwd = (session.cwd || '').trim()

  return (cwd && resolver?.(cwd)?.repoRoot) || ''
}

export function projectForSession(
  session: SessionInfo,
  projects: ProjectInfo[],
  resolver?: WorktreeResolver
): ProjectInfo | null {
  const cwd = (session.cwd || '').trim()

  if (!cwd) {
    return null
  }

  const repoRoot = sessionRepoRoot(session, resolver)
  const candidates = repoRoot && repoRoot !== cwd ? [cwd, repoRoot] : [cwd]

  let best: ProjectInfo | null = null
  let bestLen = -1

  for (const target of candidates) {
    const match = projectForPath(projects, target)

    if (!match) {
      continue
    }

    for (const folder of match.folders) {
      if (isPathUnder(folder.path, target)) {
        const len = segments(folder.path).length

        if (len > bestLen) {
          bestLen = len
          best = match
        }
      }
    }
  }

  return best
}

/** Merge session groups with live `git worktree list` lanes and per-path recents. */
export function mergeRepoWorktreeGroups(
  repo: Pick<SidebarWorkspaceTree, 'groups' | 'id' | 'path'>,
  discoveredWorktrees?: HermesGitWorktree[],
  laneSessions?: Record<string, SessionInfo[]>
): SidebarSessionGroup[] {
  const merged = [...repo.groups]
  const seenIds = new Set(merged.map(group => group.id))
  const seenPaths = new Set(merged.map(group => group.path).filter((path): path is string => Boolean(path)))
  let hasMainGroup = merged.some(group => group.isMain)
  const repoRoot = (repo.path || '').trim()

  const isMainCheckoutSession = (session: SessionInfo, root: string): boolean => {
    const cwd = (session.cwd || '').trim()
    if (!cwd || !root) {
      return false
    }
    if (cwd === root) {
      return true
    }
    const posixPrefix = `${root}/`
    const windowsPrefix = `${root}\\`
    const inRoot = cwd.startsWith(posixPrefix) || cwd.startsWith(windowsPrefix)
    if (!inRoot) {
      return false
    }
    // Linked worktrees under `<repo>/.worktrees/*` belong to their own lanes.
    return !cwd.startsWith(`${root}/.worktrees/`) && !cwd.startsWith(`${root}\\.worktrees\\`)
  }

  const branchLabelFor = (session: SessionInfo) => (session.git_branch || '').trim() || 'main'

  // Seed main-checkout branch lanes from fetched repo-root sessions so repos
  // discovered from history (with no loaded page rows) still render real lanes.
  if (repoRoot) {
    for (const session of laneSessions?.[repoRoot] ?? []) {
      if (!isMainCheckoutSession(session, repoRoot)) {
        continue
      }
      const branch = branchLabelFor(session)
      const id = `${repo.id}::branch::${branch}`
      if (seenIds.has(id)) {
        continue
      }
      merged.push({ id, isMain: true, label: branch, path: repoRoot, sessions: [] })
      seenIds.add(id)
      seenPaths.add(repoRoot)
      hasMainGroup = true
    }
  }

  for (const worktree of discoveredWorktrees ?? []) {
    const wtPath = worktree.path?.trim()

    if (!wtPath) {
      continue
    }

    if (worktree.isMain) {
      if (hasMainGroup) {
        continue
      }

      const branch = (worktree.branch?.trim() || 'main').trim()
      const id = `${repo.id}::branch::${branch}`

      if (seenIds.has(id)) {
        continue
      }

      merged.push({ id, isMain: true, label: branch, path: wtPath, sessions: [] })
      seenIds.add(id)
      seenPaths.add(wtPath)
      hasMainGroup = true

      continue
    }

    // Kanban task worktrees never get their own discovered lane — they fold into
    // the session-derived `::kanban` bucket. Listing every `git worktree list`
    // entry here is exactly what blew the sidebar up to hundreds of empty rows.
    if (kanbanWorktreeDir(wtPath)) {
      continue
    }

    if (seenPaths.has(wtPath) || seenIds.has(wtPath)) {
      continue
    }

    merged.push({
      id: wtPath,
      isMain: false,
      label: worktree.branch?.trim() || baseName(wtPath) || wtPath,
      path: wtPath,
      sessions: []
    })
    seenIds.add(wtPath)
    seenPaths.add(wtPath)
  }

  const hydrated = merged.map(group => {
    if (!group.path) {
      return group
    }

    const fetched = laneSessions?.[group.path]

    if (!fetched?.length) {
      return group
    }

    const relevant = group.isMain
      ? fetched.filter(session => isMainCheckoutSession(session, group.path!)).filter(session => branchLabelFor(session) === group.label)
      : fetched

    if (!relevant.length) {
      return group
    }

    if (!group.sessions.length) {
      return { ...group, sessions: relevant }
    }

    const byId = new Map(group.sessions.map(session => [session.id, session]))

    for (const session of relevant) {
      if (!byId.has(session.id)) {
        byId.set(session.id, session)
      }
    }

    return { ...group, sessions: [...byId.values()].sort((a, b) => b.started_at - a.started_at) }
  })

  return sortWorktreeGroups(hydrated)
}

/** A project node: human-named, holds the repo->worktree subtree for its sessions. */
export interface SidebarProjectTree {
  id: string
  label: string
  path: null | string
  color?: null | string
  icon?: null | string
  archived?: boolean
  // A git repo root promoted automatically from session cwds (not a
  // user-created entry in projects.db). Deletable = dismissable.
  isAuto?: boolean
  // The synthetic "No project" bucket for cwd-less sessions.
  isNoProject?: boolean
  repos: SidebarWorkspaceTree[]
  sessionCount: number
}

/**
 * Build the project overview: `project -> repo -> worktree -> sessions`.
 *
 * Three tiers, in order:
 *  1. **Explicit projects** (user-created, from projects.db) — always shown,
 *     even with zero sessions, so a freshly-created project is visible.
 *  2. **Auto projects** — every inferred git repo ROOT from the remaining
 *     session cwds becomes its own project (never arbitrary folders).
 *     Flagged `isAuto` so the UI can offer delete-as-dismiss and
 *     "save as project".
 *
 * Sessions with no cwd belong to no project and are simply omitted from the
 * overview (they remain in the flat recents list and search) — there is no
 * "No project" bucket. A session is claimed by the most specific explicit
 * project first (longest-prefix), so auto projects never double-count.
 */
export function projectTreeFor(
  sessions: SessionInfo[],
  projects: ProjectInfo[],
  noWorkspaceLabel: string,
  resolver?: WorktreeResolver,
  options: { preserveSessionOrder?: boolean; discoveredRepos?: DiscoveredRepo[] } = {}
): SidebarProjectTree[] {
  const activeProjects = projects.filter(project => !project.archived)
  const byProject = new Map<string, SessionInfo[]>()
  const unowned: SessionInfo[] = []

  for (const session of sessions) {
    const project = projectForSession(session, activeProjects, resolver)

    if (project) {
      const list = byProject.get(project.id) ?? []
      list.push(session)
      byProject.set(project.id, list)
    } else {
      unowned.push(session)
    }
  }

  const result: SidebarProjectTree[] = []

  // Tier 1: explicit, user-created projects.
  for (const project of activeProjects) {
    const projectSessions = byProject.get(project.id) ?? []

    result.push({
      id: project.id,
      label: project.name,
      path: project.primary_path,
      color: project.color,
      icon: project.icon,
      archived: false,
      repos: workspaceTreeFor(projectSessions, noWorkspaceLabel, resolver, options),
      sessionCount: projectSessions.length
    })
  }

  // Tier 2: derive auto-projects from leftover sessions, but ONLY for git
  // repositories (repoRoot). Non-git folders are never promoted.
  const byRepoRoot = new Map<string, SessionInfo[]>()

  for (const session of unowned) {
    const repoRoot = sessionRepoRoot(session, resolver)

    if (!repoRoot) {
      continue
    }

    const list = byRepoRoot.get(repoRoot) ?? []
    list.push(session)
    byRepoRoot.set(repoRoot, list)
  }

  const seen = new Set<string>()

  for (const [repoRoot, repoSessions] of byRepoRoot.entries()) {
    const repoNodes = workspaceTreeFor(repoSessions, noWorkspaceLabel, resolver, options)
    const repoNode = repoNodes.find(parent => parent.id === repoRoot || parent.path === repoRoot)

    if (!repoNode) {
      continue
    }

    seen.add(repoRoot)
    result.push({
      id: repoRoot,
      label: baseName(repoRoot) || repoRoot,
      path: repoRoot,
      isAuto: true,
      repos: [repoNode],
      sessionCount: repoNode.sessionCount
    })
  }

  // Tier 3: repos discovered from FULL history (backend) that have no loaded
  // session and aren't owned by an explicit project. Seeded with an empty repo
  // node so the overview lists them and drill-in hydrates lanes on demand — the
  // fix for "my repos don't show because their sessions aren't on this page".
  for (const repo of options.discoveredRepos ?? []) {
    const root = (repo.root || '').trim()

    if (!root || seen.has(root) || projectForPath(activeProjects, root)) {
      continue
    }

    seen.add(root)
    result.push({
      id: root,
      label: repo.label || baseName(root) || root,
      path: root,
      isAuto: true,
      repos: [{ id: root, label: repo.label || baseName(root) || root, path: root, groups: [], sessionCount: 0 }],
      sessionCount: repo.sessions
    })
  }

  return result
}
