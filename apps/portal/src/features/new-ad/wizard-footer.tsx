import type { ReactNode } from 'react';

/**
 * The buttons at the bottom of a step. On a wide screen: Back at the left, the other actions at the
 * right with the main one last. On a phone there is no room for three side by side, so the main
 * action takes a whole row on top and the others share the row below it.
 */
export function WizardFooter({ back, secondary, primary }: { back?: ReactNode; secondary?: ReactNode; primary?: ReactNode }) {
  const othersShareARow = Boolean(back) && Boolean(secondary);
  return (
    <div className="grid w-full grid-cols-2 gap-2 md:flex md:items-center md:justify-end">
      {primary ? <div className="order-1 col-span-2 flex md:order-3 md:col-span-1 [&>*]:flex-1 md:[&>*]:flex-none">{primary}</div> : null}
      {back ? <div className={`order-2 flex md:order-1 md:mr-auto [&>*]:flex-1 md:[&>*]:flex-none ${othersShareARow ? '' : 'col-span-2'}`}>{back}</div> : null}
      {secondary ? <div className={`order-3 flex md:order-2 [&>*]:flex-1 md:[&>*]:flex-none ${othersShareARow ? '' : 'col-span-2'}`}>{secondary}</div> : null}
    </div>
  );
}
