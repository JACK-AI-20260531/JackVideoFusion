/**
 * 撤销/重做命令栈(PRD-文本即时间线 v2.0 FR-5)
 *
 * 职责:EDL 变更的撤销/重做,快照式命令栈,默认保留 50 步(≥PRD 要求的 20 步)
 * 设计要点:
 *   - 泛型快照栈:任意不可变状态(EDL 即不可变模型)均可入栈
 *   - apply 入栈并清空 redo;undo/redo 移动指针;容量超限裁剪最旧
 */
/** 撤销/重做命令栈(快照式) */
export class CommandStack<T> {
  private undoStack: T[] = [];
  private redoStack: T[] = [];
  private current: T;
  private readonly maxDepth: number;

  /**
   * @param initial 初始状态
   * @param maxDepth 最大保留步数(默认 20,PRD 最低要求)
   */
  constructor(initial: T, maxDepth = 20) {
    this.current = initial;
    this.maxDepth = Math.max(1, maxDepth);
  }

  /**
   * 应用新状态(当前状态入撤销栈,清空重做栈)
   * @param next 新状态
   */
  apply(next: T): void {
    this.undoStack.push(this.current);
    if (this.undoStack.length > this.maxDepth) {
      this.undoStack.shift();
    }
    this.redoStack = [];
    this.current = next;
  }

  /** 撤销:返回上一状态;无路可返时返回 null */
  undo(): T | null {
    if (this.undoStack.length === 0) return null;
    this.redoStack.push(this.current);
    this.current = this.undoStack.pop() as T;
    return this.current;
  }

  /** 重做:返回下一状态;无可重做时返回 null */
  redo(): T | null {
    if (this.redoStack.length === 0) return null;
    this.undoStack.push(this.current);
    this.current = this.redoStack.pop() as T;
    return this.current;
  }

  /** 当前状态 */
  get(): T {
    return this.current;
  }

  /** 是否可撤销 */
  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /** 是否可重做 */
  canRedo(): boolean {
    return this.redoStack.length > 0;
  }
}
