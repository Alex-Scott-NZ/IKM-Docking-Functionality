import { Log } from '@microsoft/sp-core-library';
import { BaseApplicationCustomizer } from '@microsoft/sp-application-base';
import { ThemeProvider, IReadonlyTheme } from '@microsoft/sp-component-base';

import { IDockingHostProperties } from './contract';
import { DockManager } from './DockManager';

const LOG_SOURCE: string = 'DockingHostApplicationCustomizer';

/**
 * The IKM Docking Host — owns all dock zones, renders minimised utility
 * chips/tabs from registration descriptors, and arbitrates between them.
 * See DOCKING-CONTRACT.md in the IKM-Docking-Functionality repo.
 */
export default class DockingHostApplicationCustomizer
  extends BaseApplicationCustomizer<IDockingHostProperties> {

  private _manager: DockManager | undefined;

  public async onInit(): Promise<void> {
    const props: IDockingHostProperties = this.properties || {};

    if (props.enabled === false) {
      Log.info(LOG_SOURCE, 'Disabled by configuration.');
      return;
    }
    if (props.allowedSiteIds && props.allowedSiteIds.length > 0) {
      const siteId = this.context.pageContext.site.id.toString().toLowerCase();
      const allowed = props.allowedSiteIds.some(id => id.toLowerCase() === siteId);
      if (!allowed) {
        Log.info(LOG_SOURCE, `Site ${siteId} not in allowedSiteIds — not starting.`);
        return;
      }
    }

    let themePrimary: string | undefined;
    try {
      const themeProvider = this.context.serviceScope.consume(ThemeProvider.serviceKey);
      const theme: IReadonlyTheme | undefined = themeProvider.tryGetTheme();
      themePrimary = theme?.palette?.themePrimary;
    } catch (e) {
      Log.info(LOG_SOURCE, `Theme unavailable, using fallback: ${e}`);
    }

    this._manager = new DockManager(props, themePrimary);
    this._manager.start();
    this._applyEditModeVisibility();

    this.context.application.navigatedEvent.add(this, () => {
      // SPA navigation: re-check edit mode (the canvas remounts; docking UI
      // must never show in edit mode — editing chrome out-stacks everything).
      this._applyEditModeVisibility();
    });
  }

  protected onDispose(): void {
    this._manager?.dispose();
    this._manager = undefined;
  }

  private _applyEditModeVisibility(): void {
    const inEdit = /[?&]Mode=Edit/i.test(window.location.search);
    this._manager?.setHidden(inEdit);
  }
}
