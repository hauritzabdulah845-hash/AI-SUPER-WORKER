import { useEffect, useRef } from "react";

/**
 * 弹窗通用行为：Esc 关闭 / 背景滚动锁 / 焦点还原。
 *
 * 为什么不各弹窗各写一份：Console.tsx 里 12 个弹窗都是手写 backdrop，
 * 逐个加 Esc 必然漏；且「打开 A 弹窗再打开 B 弹窗」时，B 关闭不能把 A 的
 * 滚动锁一起解掉。这里用模块级计数栈统一管理，按打开的先后顺序正确出栈。
 */

/** 当前打开的弹窗数。>0 时锁住 body 滚动；回到 0 才解锁。 */
let openModals = 0;
/** 无弹窗时的原始 body 样式，解锁时精确还原（避免覆盖别处设置） */
let savedOverflow = "";
let savedPaddingRight = "";
let locked = false;

function lockScroll() {
  if (locked) return;
  locked = true;
  const body = document.body;
  savedOverflow = body.style.overflow;
  savedPaddingRight = body.style.paddingRight;

  // 锁滚动会让滚动条消失，页面横向位移一下；用等宽 padding 补回来
  const gap = window.innerWidth - document.documentElement.clientWidth;
  body.style.overflow = "hidden";
  if (gap > 0) body.style.paddingRight = `${gap}px`;
}

function unlockScroll() {
  if (!locked) return;
  locked = false;
  const body = document.body;
  body.style.overflow = savedOverflow;
  body.style.paddingRight = savedPaddingRight;
}

/**
 * @param open    弹窗是否打开
 * @param onClose 关闭回调（Esc 时调用）
 */
export function useModalBehavior(open: boolean, onClose: () => void) {
  // 用 ref 存回调：避免 onClose 每次渲染换新函数导致 effect 反复重挂，
  // 从而打乱滚动锁的引用计数（这是这类 hook 最常见的 bug）。
  // 注意：ref 只能在 effect / 事件里写 —— render 期间写 ref 在并发渲染下会读到
  // 半成品状态，React 会直接报 "Cannot access refs during render"。
  const closeRef = useRef(onClose);

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    openModals += 1;
    lockScroll();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // 不 preventDefault：让内部的输入框（如命令面板）自行处理
        event.stopPropagation();
        closeRef.current();
      }
    };
    // 用捕获阶段：确保在 React 合成事件之前拿到，避免被内部 stopPropagation 吃掉
    document.addEventListener("keydown", onKeyDown, true);

    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      openModals = Math.max(0, openModals - 1);
      if (openModals === 0) unlockScroll();

      // 焦点还原：弹窗关闭后回到打开它之前的位置，键盘用户不会「丢失光标」
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, [open]);
}

/** 测试与调试用：查询当前是否锁着滚动 */
export function __isScrollLocked() {
  return locked;
}
