import {
  ActionFlags,
  ActionHistory,
  Actions,
  BaseKind,
  Clipboard,
  Context,
  DduItem,
  DduOptions,
  PreviewContext,
  Previewer,
  SourceOptions,
} from "https://deno.land/x/ddu_vim@v2.8.3/types.ts";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
} from "https://deno.land/std@0.184.0/path/mod.ts";
import {
  Denops,
  ensureObject,
  fn,
  op,
  vars,
} from "https://deno.land/x/ddu_vim@v2.8.3/deps.ts";
import { copy, move } from "https://deno.land/std@0.184.0/fs/mod.ts";

export type ActionData = {
  bufNr?: number;
  col?: number;
  isDirectory?: boolean;
  isLink?: boolean;
  lineNr?: number;
  path?: string;
  text?: string;
};

type Params = {
  trashCommand: string[];
};

type NarrowParams = {
  path: string;
};

type OpenParams = {
  command: string;
};

type QuickFix = {
  lnum: number;
  text: string;
  col?: number;
  bufnr?: number;
  filename?: string;
};

type PreviewOption = {
  previewCmds?: string[];
};

export class Kind extends BaseKind<Params> {
  override actions: Actions<Params> = {
    append: async (args: { denops: Denops; items: DduItem[] }) => {
      for (const item of args.items) {
        await paste(args.denops, item, "p");
      }
      return Promise.resolve(ActionFlags.None);
    },
    cd: async (args: { denops: Denops; items: DduItem[] }) => {
      for (const item of args.items) {
        const dir = await getDirectory(item);
        if (dir != "") {
          const filetype = await op.filetype.getLocal(args.denops);
          await args.denops.call(
            filetype == "deol" ? "deol#cd" : "chdir",
            dir,
          );
        }
      }

      return ActionFlags.None;
    },
    copy: async (
      args: { denops: Denops; items: DduItem[]; clipboard: Clipboard },
    ) => {
      const message = `Copy to the clipboard: ${
        args.items.length > 1
          ? args.items.length + " files"
          : getPath(args.items[0])
      }`;

      await args.denops.call("ddu#kind#file#print", message);

      args.clipboard.action = "copy";
      args.clipboard.items = args.items;
      args.clipboard.mode = "";

      return ActionFlags.Persist;
    },
    delete: async (
      args: {
        denops: Denops;
        items: DduItem[];
        sourceOptions: SourceOptions;
        actionHistory: ActionHistory;
      },
    ) => {
      const message = `Are you sure you want to delete ${
        args.items.length > 1
          ? args.items.length + " files"
          : getPath(args.items[0])
      }?`;

      const confirm = await args.denops.call(
        "ddu#kind#file#confirm",
        message,
        "&Yes\n&No\n&Cancel",
        2,
      ) as number;
      if (confirm != 1) {
        return ActionFlags.Persist;
      }

      args.actionHistory.actions = [];
      for (const item of args.items) {
        await Deno.remove(getPath(item), { recursive: true });
        args.actionHistory.actions.push({
          name: "delete",
          item,
        });
      }

      return ActionFlags.RefreshItems;
    },
    executeSystem: async (
      args: { denops: Denops; items: DduItem[]; sourceOptions: SourceOptions },
    ) => {
      for (const item of args.items) {
        const action = item?.action as ActionData;
        const path = action.path ?? item.word;
        await args.denops.call("ddu#kind#file#open", path);
      }

      return ActionFlags.Persist;
    },
    feedkeys: async (args: { denops: Denops; items: DduItem[] }) => {
      for (const item of args.items) {
        await feedkeys(args.denops, item);
      }
      return Promise.resolve(ActionFlags.None);
    },
    insert: async (args: { denops: Denops; items: DduItem[] }) => {
      for (const item of args.items) {
        await paste(args.denops, item, "P");
      }
      return Promise.resolve(ActionFlags.None);
    },
    loclist: async (args: { denops: Denops; items: DduItem[] }) => {
      const qfloclist: QuickFix[] = buildQfLocList(args.items);

      if (qfloclist.length != 0) {
        await fn.setloclist(args.denops, 0, qfloclist, " ");
        await args.denops.cmd("lopen");
      }

      return ActionFlags.None;
    },
    move: async (
      args: { denops: Denops; items: DduItem[]; clipboard: Clipboard },
    ) => {
      const message = `Move to the clipboard: ${
        args.items.length > 1
          ? args.items.length + " files"
          : getPath(args.items[0])
      }`;

      await args.denops.call("ddu#kind#file#print", message);

      args.clipboard.action = "move";
      args.clipboard.items = args.items;
      args.clipboard.mode = "";

      return ActionFlags.Persist;
    },
    narrow: async (args: {
      denops: Denops;
      actionParams: unknown;
      sourceOptions: SourceOptions;
      items: DduItem[];
    }) => {
      const params = args.actionParams as NarrowParams;
      if (params.path) {
        if (params.path == "..") {
          let current = args.sourceOptions.path;
          if (current == "") {
            current = await fn.getcwd(args.denops) as string;
          }
          args.sourceOptions.path = normalize(join(current, ".."));
          return {
            flags: ActionFlags.RefreshItems,
            searchPath: current,
          };
        } else {
          args.sourceOptions.path = params.path;
          return ActionFlags.RefreshItems;
        }
      }

      for (const item of args.items) {
        const dir = await getDirectory(item);
        if (dir != "") {
          args.sourceOptions.path = dir;
          return ActionFlags.RefreshItems;
        }
      }

      return ActionFlags.None;
    },
    newDirectory: async (
      args: {
        denops: Denops;
        items: DduItem[];
        sourceOptions: SourceOptions;
        actionHistory: ActionHistory;
      },
    ) => {
      const cwd = await getTargetDirectory(
        args.denops,
        args.sourceOptions.path,
        args.items,
      );

      const input = await args.denops.call(
        "ddu#kind#file#cwd_input",
        cwd,
        "Please input a new directory name: ",
        "",
        "dir",
      ) as string;
      if (input == "") {
        return ActionFlags.Persist;
      }

      const newDirectory = isAbsolute(input) ? input : join(cwd, input);

      // Exists check
      if (await exists(newDirectory)) {
        await args.denops.call(
          "ddu#kind#file#print",
          `${newDirectory} already exists.`,
        );
        return ActionFlags.Persist;
      }

      await Deno.mkdir(newDirectory, { recursive: true });
      args.actionHistory.actions = [{
        name: "newDirectory",
        dest: newDirectory,
      }];

      return {
        flags: ActionFlags.RefreshItems,
        searchPath: newDirectory,
      };
    },
    newFile: async (
      args: {
        denops: Denops;
        items: DduItem[];
        sourceOptions: SourceOptions;
        actionHistory: ActionHistory;
      },
    ) => {
      const cwd = await getTargetDirectory(
        args.denops,
        args.sourceOptions.path,
        args.items,
      );

      const input = await args.denops.call(
        "ddu#kind#file#cwd_input",
        cwd,
        "Please input names(comma separated): ",
        "",
        "file",
      ) as string;
      if (input == "") {
        return ActionFlags.Persist;
      }

      let newFile = "";

      for (const name of input.split(",")) {
        newFile = isAbsolute(name) ? name : join(cwd, name);

        // Exists check
        if (await exists(newFile)) {
          await args.denops.call(
            "ddu#kind#file#print",
            `${newFile} already exists.`,
          );
          continue;
        }

        if (newFile.slice(-1) == "/") {
          await Deno.mkdir(newFile, { recursive: true });
        } else {
          await Deno.writeTextFile(newFile, "");
        }
      }

      if (newFile == "") {
        return ActionFlags.Persist;
      }

      args.actionHistory.actions = [{
        name: "newFile",
        dest: newFile,
      }];

      return {
        flags: ActionFlags.RefreshItems,
        searchPath: newFile,
      };
    },
    open: async (args: {
      denops: Denops;
      context: Context;
      actionParams: unknown;
      items: DduItem[];
    }) => {
      const params = args.actionParams as OpenParams;
      const openCommand = params.command ?? "edit";

      for (const item of args.items) {
        const action = item?.action as ActionData;

        if (action.bufNr != null) {
          if (openCommand != "edit") {
            await args.denops.call(
              "ddu#util#execute_path",
              openCommand,
              action.path ?? "",
            );
          }
          // NOTE: bufNr may be hidden
          await fn.bufload(args.denops, action.bufNr);
          await args.denops.cmd(`buffer ${action.bufNr}`);
        } else {
          const path = action.path ?? item.word;
          if (new RegExp("^https?://").test(path)) {
            // URL
            await args.denops.call("ddu#kind#file#open", path);
            continue;
          }
          await args.denops.call(
            "ddu#util#execute_path",
            openCommand,
            path,
          );
        }

        const mode = await fn.mode(args.denops);
        if (action.lineNr != null) {
          await fn.cursor(args.denops, action.lineNr, 0);

          if (args.context.input != "") {
            // Search the input text
            const text = (await fn.getline(args.denops, ".")).toLowerCase();
            const input = args.context.input.toLowerCase();
            await fn.cursor(
              args.denops,
              0,
              text.indexOf(input) + 1 + (mode == "i" ? 1 : 0),
            );
          }
        }

        if (action.col != null) {
          // If it is insert mode, it needs adjust.
          await fn.cursor(args.denops, 0, action.col + (mode == "i" ? 1 : 0));
        }

        // Note: Open folds and centering
        await args.denops.cmd("normal! zvzz");
      }

      return ActionFlags.None;
    },
    paste: async (
      args: {
        denops: Denops;
        items: DduItem[];
        sourceOptions: SourceOptions;
        clipboard: Clipboard;
        actionHistory: ActionHistory;
      },
    ) => {
      const cwd = await getTargetDirectory(
        args.denops,
        args.sourceOptions.path,
        args.items,
      );

      let searchPath = "";
      let defaultConfirm = "";
      args.actionHistory.actions = [];
      switch (args.clipboard.action) {
        case "copy":
          for (const item of args.clipboard.items) {
            const action = item?.action as ActionData;
            const path = action.path ?? item.word;

            const ret = await checkOverwrite(
              args.denops,
              path,
              join(cwd, basename(path)),
              defaultConfirm,
            );
            const dest = ret.dest;
            defaultConfirm = ret.defaultConfirm;
            if (dest == "") {
              continue;
            }

            await Deno.mkdir(dirname(dest), { recursive: true });

            // Cannot overwrite files
            if (await exists(dest)) {
              await Deno.remove(dest, { recursive: true });
            }

            await copy(path, dest, { overwrite: true });

            searchPath = dest;

            args.actionHistory.actions.push({
              name: "copy",
              item,
              dest,
            });
          }
          break;
        case "move":
          for (const item of args.clipboard.items) {
            const action = item?.action as ActionData;
            const path = action.path ?? item.word;
            const ret = await checkOverwrite(
              args.denops,
              path,
              join(cwd, basename(path)),
              defaultConfirm,
            );
            const dest = ret.dest;
            defaultConfirm = ret.defaultConfirm;
            if (dest == "") {
              continue;
            }

            await Deno.mkdir(dirname(dest), { recursive: true });

            // Cannot overwrite files
            if (await exists(dest)) {
              await Deno.remove(dest, { recursive: true });
            }

            await move(path, dest);

            searchPath = dest;

            args.actionHistory.actions.push({
              name: "move",
              item,
              dest,
            });
          }
          break;
        default:
          await args.denops.call(
            "ddu#kind#file#print",
            `Invalid action: ${args.clipboard.action}`,
          );
          return ActionFlags.Persist;
      }

      if (searchPath == "") {
        return ActionFlags.Persist;
      } else {
        return {
          flags: ActionFlags.RefreshItems,
          searchPath,
        };
      }
    },
    quickfix: async (args: { denops: Denops; items: DduItem[] }) => {
      const qfloclist: QuickFix[] = buildQfLocList(args.items);

      if (qfloclist.length != 0) {
        await fn.setqflist(args.denops, qfloclist, " ");
        await args.denops.cmd("copen");
      }

      return ActionFlags.None;
    },
    rename: async (args: {
      denops: Denops;
      options: DduOptions;
      items: DduItem[];
      sourceOptions: SourceOptions;
      actionHistory: ActionHistory;
    }) => {
      if (args.items.length > 1) {
        // Use exrename instead
        await args.denops.call(
          "ddu#kind#file#exrename#create_buffer",
          args.items.map((item) => {
            return {
              action__path: (item?.action as ActionData).path ?? item.word,
            };
          }),
          {
            name: args.options.name,
          },
        );
        return ActionFlags.Persist;
      }

      let cwd = args.sourceOptions.path;
      if (cwd == "") {
        cwd = await fn.getcwd(args.denops) as string;
      }

      let newPath = "";
      args.actionHistory.actions = [];
      for (const item of args.items) {
        const action = item?.action as ActionData;
        const path = action.path ?? item.word;

        newPath = await args.denops.call(
          "ddu#kind#file#cwd_input",
          cwd,
          `Please input a new name: ${path} -> `,
          path,
          (await isDirectory(path)) ? "dir" : "file",
        ) as string;

        if (newPath == "" || path == newPath) {
          continue;
        }

        // Exists check
        if (await exists(newPath)) {
          await args.denops.call(
            "ddu#kind#file#print",
            `${newPath} already exists.`,
          );
          return ActionFlags.Persist;
        }

        await Deno.mkdir(dirname(newPath), { recursive: true });

        await Deno.rename(path, newPath);

        await args.denops.call(
          "ddu#kind#file#buffer_rename",
          await fn.bufnr(args.denops, path),
          newPath,
        );

        args.actionHistory.actions.push({
          name: "rename",
          item,
          dest: newPath,
        });
      }

      return {
        flags: ActionFlags.RefreshItems,
        searchPath: newPath,
      };
    },
    trash: async (
      args: {
        denops: Denops;
        items: DduItem[];
        sourceOptions: SourceOptions;
        kindParams: Params;
        actionHistory: ActionHistory;
      },
    ) => {
      const message = `Are you sure you want to move to the trash ${
        args.items.length > 1
          ? args.items.length + " files"
          : getPath(args.items[0])
      }?`;

      const confirm = await args.denops.call(
        "ddu#kind#file#confirm",
        message,
        "&Yes\n&No\n&Cancel",
        2,
      ) as number;
      if (confirm != 1) {
        return ActionFlags.Persist;
      }

      const trashCommand = args.kindParams.trashCommand;

      if (!await fn.executable(args.denops, trashCommand[0])) {
        await args.denops.call(
          "ddu#util#print_error",
          `${trashCommand[0]} is not found.`,
        );
        return ActionFlags.Persist;
      }

      args.actionHistory.actions = [];
      for (const item of args.items) {
        const cmd = Array.from(trashCommand);
        cmd.push(getPath(item));
        try {
          const p = Deno.run({
            cmd,
            stdout: "piped",
            stderr: "piped",
            stdin: "piped",
          });
          await p.status();
        } catch (e) {
          await args.denops.call(
            "ddu#util#print_error",
            `Run ${cmd} is failed.`,
          );

          if (e instanceof Error) {
            await args.denops.call(
              "ddu#util#print_error",
              e.message,
            );
          }
        }

        args.actionHistory.actions.push({
          name: "trash",
          item,
        });
      }

      return ActionFlags.RefreshItems;
    },
    undo: async (
      args: {
        denops: Denops;
        items: DduItem[];
        sourceOptions: SourceOptions;
        actionHistory: ActionHistory;
      },
    ) => {
      let searchPath = "";

      for (const action of args.actionHistory.actions.reverse()) {
        switch (action.name) {
          case "copy":
          case "newDirectory":
          case "newFile":
            if (action.dest) {
              await Deno.remove(action.dest, { recursive: true });
            }
            break;
          case "move":
          case "rename":
            if (action.dest && action.item) {
              await move(
                action.dest,
                getPath(action.item),
              );
              searchPath = getPath(action.item);
            }
            break;
          default:
            await args.denops.call(
              "ddu#kind#file#print",
              `Cannot undo action: ${action.name}`,
            );
            return ActionFlags.Persist;
        }
      }

      // Clear
      args.actionHistory.actions = [];

      return {
        flags: ActionFlags.RefreshItems,
        searchPath,
      };
    },
    yank: async (args: { denops: Denops; items: DduItem[] }) => {
      for (const item of args.items) {
        const action = item?.action as ActionData;
        const path = action.path ?? item.word;

        await fn.setreg(args.denops, '"', path, "v");
        await fn.setreg(
          args.denops,
          await vars.v.get(args.denops, "register"),
          path,
          "v",
        );
      }

      return ActionFlags.Persist;
    },
  };

  override async getPreviewer(args: {
    denops: Denops;
    item: DduItem;
    actionParams: unknown;
    previewContext: PreviewContext;
  }): Promise<Previewer | undefined> {
    const action = args.item.action as ActionData;
    if (!action) {
      return undefined;
    }

    const param = ensureObject(args.actionParams) as PreviewOption;

    if (action.path && param.previewCmds?.length) {
      const previewHeight = args.previewContext.height;
      let startLine = 0;
      let lineNr = 0;
      if (action.lineNr) {
        lineNr = action.lineNr;
        startLine = Math.max(
          0,
          Math.ceil(action.lineNr - previewHeight / 2),
        );
      }

      const pairs: Record<string, string> = {
        s: action.path,
        l: String(lineNr),
        h: String(previewHeight),
        e: String(startLine + previewHeight),
        b: String(startLine),
        "%": "%",
      };
      const replacer = (
        match: string,
        p1: string,
      ) => {
        if (!p1.length || !(p1 in pairs)) {
          throw `invalid item ${match}`;
        }
        return pairs[p1];
      };
      const replaced: string[] = [];
      try {
        for (const cmd of param.previewCmds) {
          replaced.push(cmd.replace(/%(.?)/g, replacer));
        }
      } catch (e) {
        return {
          kind: "nofile",
          contents: ["Error", e.toString()],
          highlights: [{
            name: "ddu-kind-file-error",
            "hl_group": "Error",
            row: 1,
            col: 1,
            width: 5,
          }],
        };
      }

      return {
        kind: "terminal",
        cmds: replaced,
      };
    }

    if (action.bufNr) {
      // NOTE: buffer may be hidden
      await fn.bufload(args.denops, action.bufNr);
    }

    return {
      kind: "buffer",
      path: action.bufNr ? undefined : action.path,
      expr: action.bufNr,
      lineNr: action.lineNr,
    };
  }

  override params(): Params {
    return {
      trashCommand: ["gio", "trash"],
    };
  }
}

const buildQfLocList = (items: DduItem[]) => {
  const qfloclist: QuickFix[] = [];

  for (const item of items) {
    const action = item?.action as ActionData;

    const qfloc = {
      text: item.word,
    } as QuickFix;

    if (action.lineNr) {
      qfloc.lnum = action.lineNr;
    }
    if (action.col) {
      qfloc.col = action.col;
    }
    if (action.bufNr) {
      qfloc.bufnr = action.bufNr;
    }
    if (action.path) {
      qfloc.filename = action.path;
    }
    if (action.text) {
      qfloc.text = action.text;
    }

    qfloclist.push(qfloc);
  }

  return qfloclist;
};

const getTargetDirectory = async (
  denops: Denops,
  initPath: string,
  items: DduItem[],
) => {
  let dir = initPath;
  for (const item of items) {
    const action = item?.action as ActionData;
    const path = action.path ?? item.word;

    dir = item.__expanded ? path : dirname(path);
  }

  if (dir == "") {
    dir = await fn.getcwd(denops) as string;
  }

  return dir;
};

const getDirectory = async (item: DduItem) => {
  const action = item?.action as ActionData;

  // Note: Deno.stat() may be failed
  try {
    const path = action.path ?? item.word;
    const dir = (action.isDirectory ?? (await Deno.stat(path)).isDirectory)
      ? path
      : dirname(path);
    if ((await Deno.stat(dir)).isDirectory) {
      return dir;
    }
  } catch (_e: unknown) {
    // Ignore
  }

  return "";
};

const getPath = (item: DduItem) => {
  const action = item?.action as ActionData;
  return action.path ?? item.word;
};

const exists = async (path: string) => {
  // Note: Deno.stat() may be failed
  try {
    const stat = await Deno.stat(path);
    if (stat.isDirectory || stat.isFile || stat.isSymlink) {
      return true;
    }
  } catch (_: unknown) {
    // Ignore stat exception
  }

  return false;
};

const isDirectory = async (path: string) => {
  // Note: Deno.stat() may be failed
  try {
    const stat = await Deno.stat(path);
    return stat.isDirectory;
  } catch (_: unknown) {
    // Ignore stat exception
  }

  return false;
};

const checkOverwrite = async (
  denops: Denops,
  src: string,
  dest: string,
  defaultConfirm: string,
): Promise<{ dest: string; defaultConfirm: string }> => {
  if (!(await exists(src))) {
    return { dest: "", defaultConfirm: "" };
  }
  if (!(await exists(dest))) {
    return { dest, defaultConfirm: "" };
  }

  const sStat = await Deno.stat(src);
  const dStat = await Deno.stat(dest);

  const message = ` src: ${src} ${sStat.size} bytes\n` +
    `      ${sStat.mtime?.toISOString()}\n` +
    `dest: ${dest} ${dStat.size} bytes\n` +
    `      ${dStat.mtime?.toISOString()}\n` +
    `${dest} already exists.  Overwrite? (Upper case is all)\n` +
    "f[orce]/t[ime]/u[nderbar]/n[o]/r[ename] : ";

  // NOTE: Uppercase defaultConfirm skips user input
  const confirm =
    (defaultConfirm != "" && defaultConfirm.toLowerCase() != defaultConfirm)
      ? defaultConfirm
      : await denops.call(
        "ddu#kind#file#check_overwrite_method",
        message,
        "no",
      ) as string;

  let ret = "";

  switch (confirm.toLowerCase()) {
    case "f":
      ret = dest;
      break;
    case "n":
      break;
    case "r":
      ret = await denops.call(
        "ddu#kind#file#cwd_input",
        "",
        `Please input a new name: ${dest} -> `,
        dest,
        (await isDirectory(src)) ? "dir" : "file",
      ) as string;
      if (ret == dest) {
        ret = "";
      }
      break;
    case "t":
      if (dStat.mtime && sStat.mtime && dStat.mtime < sStat.mtime) {
        ret = src;
      }
      break;
    case "u":
      ret = dest + "_";
      break;
  }

  return { dest: ret, defaultConfirm: confirm };
};

const paste = async (denops: Denops, item: DduItem, pasteKey: string) => {
  const action = item?.action as ActionData;

  if (action.path == null) {
    return;
  }

  const oldValue = fn.getreg(denops, '"');
  const oldType = fn.getregtype(denops, '"');

  await fn.setreg(denops, '"', action.path, "v");
  try {
    await denops.cmd('normal! ""' + pasteKey);
  } finally {
    await fn.setreg(denops, '"', oldValue, oldType);
  }

  // Open folds
  await denops.cmd("normal! zv");
};

const feedkeys = async (denops: Denops, item: DduItem) => {
  const action = item?.action as ActionData;

  if (action.path == null) {
    return;
  }

  // Use feedkeys() instead
  await fn.feedkeys(denops, action.path, "n");
};
