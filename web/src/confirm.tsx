// 落笔前确认弹层：替代裸 window.confirm，宣纸底弹层——用于「这个动作会真实写入数据
// 或触发跳转」但又不是危险删除的场合（摆示例菜、去补做法…）。
// 现有页面里删除类动作（删菜/删记录/清单/重置链接）仍沿用原生 confirm()，不在本组件改动范围内。
export default function ConfirmSheet({
  title, content, confirmText = "确定", cancelText = "取消", onConfirm, onCancel,
}: {
  title: string; content: string; confirmText?: string; cancelText?: string;
  onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <div className="sheetscrim" onClick={onCancel}>
      <div className="confirmsheet" onClick={e => e.stopPropagation()}>
        <div className="confirmsheet-t">{title}</div>
        <div className="confirmsheet-c">{content}</div>
        <div className="row" style={{ marginTop: 18 }}>
          <button className="btn ghost" onClick={onCancel}>{cancelText}</button>
          <button className="btn" onClick={onConfirm}>{confirmText}</button>
        </div>
      </div>
    </div>
  );
}
