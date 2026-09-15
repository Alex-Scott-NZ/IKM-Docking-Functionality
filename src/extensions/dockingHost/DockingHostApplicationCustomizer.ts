import { Log } from '@microsoft/sp-core-library';
import {
  BaseApplicationCustomizer,
  PlaceholderName,
  PlaceholderContent
} from '@microsoft/sp-application-base';
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
  private _bottomPlaceholder: PlaceholderContent | undefined;

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

    // The bottom dock zone lives in the SPFx-reserved Bottom placeholder,
    // alongside the other bottom-of-page extensions (feedback, the community
    // scroll-to-top) — not loose on document.body. Edge zones have no
    // placeholder equivalent and stay body-mounted.
    this._bottomPlaceholder = this.context.placeholderProvider.tryCreateContent(
      PlaceholderName.Bottom,
      { onDispose: () => { /* manager dispose handles DOM */ } }
    );

    this._manager = new DockManager(props, themePrimary, this._bottomPlaceholder?.domElement);
    this._manager.start();
    this._applyVisibility();

    this.context.application.navigatedEvent.add(this, () => {
      // SPA navigation: re-check edit mode AND the surface type (the reader
      // can move between a page and a list view without a full reload).
      this._applyVisibility();
    });
  }

  protected onDispose(): void {
    this._manager?.dispose();
    this._manager = undefined;
  }

  private _applyVisibility(): void {
    // Hidden in edit mode (editing chrome out-stacks everything) and on
    // non-reading surfaces (user decision 2026-09-15 after the edge tab
    // covered the Site Pages library's columns).
    const inEdit = /[?&]Mode=Edit/i.test(window.location.search);
    this._manager?.setHidden(inEdit || !this._isReadingSurface());
  }

  /**
   * Dock chrome is a READING aid: it renders only on modern site pages.
   * List and library views, forms and system pages have edge-to-edge
   * content and no reading journey — the host withdraws entirely there.
   */
  private _isReadingSurface(): boolean {
    try {
      const pc = this.context.pageContext as unknown as {
        listItem?: object | null;
        list?: { serverRelativeUrl?: string } | null;
      };
      const path = window.location.pathname.toLowerCase();
      // Library view pages (incl. the Site Pages library's own views).
      if (path.indexOf('/forms/') !== -1) { return false; }
      const listUrl = (pc.list && pc.list.serverRelativeUrl
        ? String(pc.list.serverRelativeUrl)
        : ''
      ).toLowerCase();
      const inSitePages =
        listUrl.indexOf('/sitepages') !== -1 || path.indexOf('/sitepages/') !== -1;
      // A modern site page is an ITEM in the Site Pages library; a list or
      // library VIEW has no current item.
      return !!pc.listItem && inSitePages;
    } catch {
      return true; // fail open — never blank a real page over a probe error
    }
  }
}
