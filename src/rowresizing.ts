import { Attrs, Node as ProsemirrorNode } from 'prosemirror-model';
import { EditorState, Plugin, PluginKey, Transaction } from 'prosemirror-state';
import {
  Decoration,
  DecorationSet,
  EditorView,
  NodeView,
} from 'prosemirror-view';
import { tableNodeTypes } from './schema';
import { TableMap } from './tablemap';
import { cellAround, CellAttrs, pointsAtCell } from './util';

/**
 * @public
 */
export const rowResizingPluginKey = new PluginKey<RowResizeState>(
  'tableRowResizing',
);

/**
 * @public
 */
export type RowResizingOptions = {
  handleHeight?: number;
  cellMinHeight?: number;
  lastRowResizable?: boolean;
  View?: new (
    node: ProsemirrorNode,
    cellMinHeight: number,
    view: EditorView,
  ) => NodeView;
};

/**
 * @public
 */
export type DraggingRow = { startY: number; startHeight: number };

/**
 * @public
 */
export function rowResizing({
  handleHeight = 5,
  cellMinHeight = 25,
  View = TableRowsView,
  lastRowResizable = true,
}: RowResizingOptions = {}): Plugin {
  const plugin = new Plugin<RowResizeState>({
    key: rowResizingPluginKey,
    state: {
      init(_, state) {
        plugin.spec!.props!.nodeViews![
          tableNodeTypes(state.schema).table.name
        ] = (node, view) => new View(node, cellMinHeight, view);
        return new RowResizeState(-1, false);
      },
      apply(tr, prev) {
        return prev.apply(tr);
      },
    },
    props: {
      attributes: (state): Record<string, string> => {
        const pluginState = rowResizingPluginKey.getState(state);
        return pluginState && pluginState.activeHandle > -1
          ? { class: 'resize-cursor' }
          : {};
      },

      handleDOMEvents: {
        mousemove: (view, event) => {
          handleMouseMove(
            view,
            event,
            handleHeight,
            cellMinHeight,
            lastRowResizable,
          );
        },
        mouseleave: (view) => {
          handleMouseLeave(view);
        },
        mousedown: (view, event) => {
          handleMouseDown(view, event, cellMinHeight);
        },
      },

      decorations: (state) => {
        const pluginState = rowResizingPluginKey.getState(state);
        if (pluginState && pluginState.activeHandle > -1) {
          return handleDecorations(state, pluginState.activeHandle);
        }
      },

      nodeViews: {},
    },
  });
  return plugin;
}

/**
 * @public
 */
export class RowResizeState {
  constructor(public activeHandle: number, public draggingRow: DraggingRow | false) {}

  apply(tr: Transaction): RowResizeState {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const state = this;
    const action = tr.getMeta(rowResizingPluginKey);
    if (action && action.setHandle != null)
      return new RowResizeState(action.setHandle, false);
    if (action && action.setDraggingRow !== undefined)
      return new RowResizeState(state.activeHandle, action.setDraggingRow);
    if (state.activeHandle > -1 && tr.docChanged) {
      let handle = tr.mapping.map(state.activeHandle, -1);
      if (!pointsAtCell(tr.doc.resolve(handle))) {
        handle = -1;
      }
      return new RowResizeState(handle, state.draggingRow);
    }
    return state;
  }
}

function handleMouseMove(
  view: EditorView,
  event: MouseEvent,
  handleHeight: number,
  cellMinHeight: number,
  lastRowResizable: boolean,
): void {
  const pluginState = rowResizingPluginKey.getState(view.state);
  if (!pluginState) return;

  if (!pluginState.draggingRow) {
    const target = domCellAround(event.target as HTMLElement);
    let cell = -1;
    if (target) {
      const { left, right } = target.getBoundingClientRect();
      if (event.clientX - left <= handleHeight)
        cell = edgeCell(view, event, 'left', handleHeight);
      else if (right - event.clientX <= handleHeight)
        cell = edgeCell(view, event, 'right', handleHeight);
    }

    if (cell != pluginState.activeHandle) {
      if (!lastRowResizable && cell !== -1) {
        const $cell = view.state.doc.resolve(cell);
        const table = $cell.node(-1);
        const map = TableMap.get(table);
        const tableStart = $cell.start(-1);
        const col =
          map.colCount($cell.pos - tableStart) +
          $cell.nodeAfter!.attrs.colspan -
          1;

        if (col === map.width - 1) {
          return;
        }
      }

      updateHandle(view, cell);
    }
  }
}

function handleMouseLeave(view: EditorView): void {
  const pluginState = rowResizingPluginKey.getState(view.state);
  if (pluginState && pluginState.activeHandle > -1 && !pluginState.draggingRow)
    updateHandle(view, -1);
}

function handleMouseDown(
  view: EditorView,
  event: MouseEvent,
  cellMinHeight: number,
): boolean {
  const pluginState = rowResizingPluginKey.getState(view.state);
  if (!pluginState || pluginState.activeHandle === -1 || pluginState.draggingRow)
    return false;

  const cell = view.state.doc.nodeAt(pluginState.activeHandle)!;
  // const width = currentRowHeight(view, pluginState.activeHandle, cell.attrs);
  view.dispatch(
    view.state.tr.setMeta(rowResizingPluginKey, {
      setDraggingRow: { startY: event.clientY, startHeight: cell.attrs.height },
    }),
  );

  function finish(event: MouseEvent) {
    window.removeEventListener('mouseup', finish);
    window.removeEventListener('mousemove', move);
    const pluginState = rowResizingPluginKey.getState(view.state);
    if (pluginState?.draggingRow) {
      updateRowHeight(
        view,
        pluginState.activeHandle,
        draggedHeight(pluginState.draggingRow, event, cellMinHeight),
      );
      view.dispatch(
        view.state.tr.setMeta(rowResizingPluginKey, { setDraggingRow: null }),
      );
    }
  }

  function move(event: MouseEvent): void {
    if (!event.which) return finish(event);
    const pluginState = rowResizingPluginKey.getState(view.state);
    if (!pluginState) return;
    if (pluginState.draggingRow) {
      const dragged = draggedHeight(pluginState.draggingRow, event, cellMinHeight);
      displayRowHeight(view, pluginState.activeHandle, dragged, cellMinHeight);
    }
  }

  window.addEventListener('mouseup', finish);
  window.addEventListener('mousemove', move);
  event.preventDefault();
  return true;
}

// function currentRowHeight(
//   view: EditorView,
//   cellPos: number,
//   { colspan, height }: Attrs,
// ): number {
//   const width = colwidth && colwidth[colwidth.length - 1];
//   if (width) return width;
//   const dom = view.domAtPos(cellPos);
//   const node = dom.node.childNodes[dom.offset] as HTMLElement;
//   let domWidth = node.offsetWidth,
//     parts = colspan;
//   if (colwidth)
//     for (let i = 0; i < colspan; i++)
//       if (colwidth[i]) {
//         domWidth -= colwidth[i];
//         parts--;
//       }
//   return domWidth / parts;
// }

function domCellAround(target: HTMLElement | null): HTMLElement | null {
  while (target && target.nodeName != 'TD' && target.nodeName != 'TH')
    target =
      target.classList && target.classList.contains('ProseMirror')
        ? null
        : (target.parentNode as HTMLElement);
  return target;
}

function edgeCell(
  view: EditorView,
  event: MouseEvent,
  side: 'left' | 'right',
  handleHeight: number,
): number {
  // posAtCoords returns inconsistent positions when cursor is moving
  // across a collapsed table border. Use an offset to adjust the
  // target viewport coordinates away from the table border.
  const offset = side === 'right' ? -handleHeight : handleHeight;
  const found = view.posAtCoords({
    left: event.clientX + offset,
    top: event.clientY,
  });
  if (!found) return -1;
  const { pos } = found;
  const $cell = cellAround(view.state.doc.resolve(pos));
  if (!$cell) return -1;
  if (side === 'right') return $cell.pos;
  const map = TableMap.get($cell.node(-1)),
    start = $cell.start(-1);
  const index = map.map.indexOf($cell.pos - start);
  return index % map.width === 0 ? -1 : start + map.map[index - 1];
}

function draggedHeight(
  draggingRow: DraggingRow,
  event: MouseEvent,
  cellMinHeight: number,
): number {
  const offset = event.clientY - draggingRow.startY;
  return Math.max(cellMinHeight, draggingRow.startHeight + offset);
}

function updateHandle(view: EditorView, value: number): void {
  view.dispatch(
    view.state.tr.setMeta(rowResizingPluginKey, { setHandle: value }),
  );
}

interface CellAttrsWithHeight extends CellAttrs {
  height: number;
}

function updateRowHeight(
  view: EditorView,
  cell: number,
  height: number,
): void {
  console.log('cell', cell);
  const $cell = view.state.doc.resolve(cell);
  const table = $cell.node(-1),
    map = TableMap.get(table),
    start = $cell.start(-1);
  const col =
    map.colCount($cell.pos - start) + $cell.nodeAfter!.attrs.colspan - 1;
  const tr = view.state.tr;
  const row = $cell.index(-1);
  for (let i = 0; i < map.width; i++) {
    const mapIndex = row * map.width + i;
    // Rowspanning cell that has already been handled
    // if (row ?? map.map[mapIndex] === map.map[mapIndex - map.width]) {
    //   console.log(`skipping row ${row}`);
    //   continue;
    // }
    const pos = map.map[mapIndex];
    const attrs = table.nodeAt(pos)!.attrs as CellAttrsWithHeight;

    // const index = attrs.colspan === 1 ? 0 : col - map.colCount(pos);
    // if (attrs.height && attrs.height[index] === height) continue;
    // console.log(`setting row ${row} column heyooo to ${height}px high`);
    // console.log('start + pos', start + pos);

    tr.setNodeMarkup(start + pos, null, { ...attrs, height });
  }
  if (tr.docChanged) view.dispatch(tr);
}

function displayRowHeight(
  view: EditorView,
  cell: number,
  height: number,
  cellMinHeight: number,
): void {
  const $cell = view.state.doc.resolve(cell);
  const table = $cell.node(-1),
    start = $cell.start(-1);
  // const col =
  //   TableMap.get(table).colCount($cell.pos - start) +
  //   $cell.nodeAfter!.attrs.colspan -
  //   1;
  const row = $cell.index(-1);
  let dom: Node | null = view.domAtPos($cell.start(-1)).node;
  while (dom && dom.nodeName != 'TABLE') {
    dom = dom.parentNode;
  }
  if (!dom) return;
  updateRowsOnResize(
    table,
    dom.firstChild as HTMLTableColElement,
    dom as HTMLTableElement,
    cellMinHeight,
    row,
    height,
  );
}

function zeroes(n: number): 0[] {
  return Array(n).fill(0);
}

// TODO:  get the handles moved to the horizontal borders
export function handleDecorations(
  state: EditorState,
  cell: number,
): DecorationSet {
  const decorations = [];
  const $cell = state.doc.resolve(cell);
  const table = $cell.node(-1);
  if (!table) {
    return DecorationSet.empty;
  }
  const map = TableMap.get(table);
  const start = $cell.start(-1);
  const col: number = map.colCount($cell.pos - start) + $cell.nodeAfter!.attrs.colspan;
  for (let row = 0; row < map.height; row++) {
    const index = (row + 1)* map.width - 1;
    // For positions that have either a different cell or the end
    // of the table to their right, and either the top of the table or
    // a different cell above them, add a decoration
    if (
      (col === map.width || map.map[index] != map.map[index + 1]) &&
      (row === 0 || map.map[index] != map.map[index - map.width])
    ) {
      const cellPos = map.map[index];
      const pos = start + cellPos + table.nodeAt(cellPos)!.nodeSize - 1;
      const dom = document.createElement('div');
      dom.className = 'row-resize-handle';
      decorations.push(Decoration.widget(pos, dom));
    }
  }
  return DecorationSet.create(state.doc, decorations);
}

export class TableRowsView implements NodeView {
  public dom: HTMLDivElement;
  public table: HTMLTableElement;
  public colgroup: HTMLTableColElement;
  public contentDOM: HTMLTableSectionElement;

  constructor(public node: ProsemirrorNode, public cellMinHeight: number) {
    this.dom = document.createElement('div');
    this.dom.className = 'tableWrapper';
    this.table = this.dom.appendChild(document.createElement('table'));
    this.colgroup = this.table.appendChild(document.createElement('colgroup'));
    updateRowsOnResize(node, this.colgroup, this.table, cellMinHeight);
    this.contentDOM = this.table.appendChild(document.createElement('tbody'));
  }

  update(node: ProsemirrorNode): boolean {
    if (node.type != this.node.type) return false;
    this.node = node;
    updateRowsOnResize(node, this.colgroup, this.table, this.cellMinHeight);
    return true;
  }

  ignoreMutation(record: MutationRecord): boolean {
    return (
      record.type === 'attributes' &&
      (record.target === this.table || this.colgroup.contains(record.target))
    );
  }
}


const updateRowsOnResize = (
  node: ProsemirrorNode,
  colgroup: HTMLTableColElement,
  table: HTMLTableElement,
  cellMinHeight: number,
  overrideRow?: number,
  overrideValue?: number,
): void => {

  // console.log(table.rows[1], Array.from(table.rows[1]?.firstChild?.childNodes ?? []));

  const totalHeight = 0;
  const fixedHeight = true;
  // console.log('table.rows', table.rows);
  let nextDOM = table.rows[overrideRow ?? 0]?.firstChild as HTMLElement;
  // let nextDOM = colgroup.firstChild as HTMLElement;

  const rowNode = node.firstChild;

  if (!rowNode) return;

  // Array.from(table.rows).forEach((row, rowIndex) => {
  //   if (overrideRow === undefined || overrideValue === undefined) return;
  //   Array.from(row.children).forEach((cell, cellIndex) => {
  //     console.log('overrideRow', overrideRow);
  //     console.log('overrideValue', overrideValue);
  //     const height = overrideValue !== undefined ? `${overrideValue}px` : '';
  //     cell.setAttribute('height', `height: ${height}px`);
  //   });
  // });

  for (let i = 0, rowIndex = 0; i < rowNode.childCount; i++) {
    if (overrideRow !== undefined && overrideRow !== rowIndex) continue;
    if (overrideValue !== undefined) {
      console.log('overrideRow', overrideRow);
      console.log('overrideValue', overrideValue);
      table.rows[rowIndex].style.height = `${overrideValue}px`;
    }
    // const cell = rowNode.child(i);
    // const { colspan, heights } = cell.attrs as CellAttrsWithHeight;
    // for (let j = 0; j < colspan; j++, rowIndex++) {
    //   if (overrideRow !== undefined && overrideRow !== rowIndex) continue;
    //   const hasHeight =
    //     overrideRow === rowIndex ? overrideValue : heights && heights[j];
    //   const cssHeight = hasHeight ? hasHeight + 'px' : '';
    //   totalHeight += hasHeight || cellMinHeight;
    //   if (!hasHeight) fixedHeight = false;
    //   if (!nextDOM) {
    //     // console.log('no nextdom');
    //     // TODO: handle adding a row
    //     // table.appendChild(document.createElement('tr')).style.height = cssHeight;
    //   } else {
    //     if (overrideRow) console.log('nextDOM', nextDOM);
    //     if (nextDOM.style.height != cssHeight) {
    //       nextDOM.style.height = cssHeight;
    //       table.rows[rowIndex].removeChild(nextDOM);
    //     }
    //     nextDOM = nextDOM.nextSibling as HTMLElement;
    //     if (overrideRow) console.log('nextDOM', nextDOM);
    //   }
    // }
  }

  while (nextDOM) {
    const after = nextDOM.nextSibling;
    nextDOM.parentNode?.removeChild(nextDOM);
    nextDOM = after as HTMLElement;
  }

  if (fixedHeight) {
    table.style.height = totalHeight + 'px';
    table.style.minHeight = '';
  } else {
    table.style.height = '';
    table.style.minHeight = totalHeight + 'px';
  }
}
