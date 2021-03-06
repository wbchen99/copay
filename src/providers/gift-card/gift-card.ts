import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { ImageLoader } from 'ionic-image-loader';
import * as _ from 'lodash';
import { Observable, Subject } from 'rxjs';
import { from } from 'rxjs/observable/from';
import { fromPromise } from 'rxjs/observable/fromPromise';
import { of } from 'rxjs/observable/of';
import { mergeMap } from 'rxjs/operators';
import { promiseSerial } from '../../utils';
import { ConfigProvider } from '../config/config';
import { EmailNotificationsProvider } from '../email-notifications/email-notifications';
import { HomeIntegrationsProvider } from '../home-integrations/home-integrations';
import { Logger } from '../logger/logger';
import {
  GiftCardMap,
  Network,
  PersistenceProvider
} from '../persistence/persistence';
import { TimeProvider } from '../time/time';
import {
  ApiCardConfig,
  AvailableCardMap,
  CardConfig,
  CardConfigMap,
  GiftCard,
  GiftCardSaveParams
} from './gift-card.types';

@Injectable()
export class GiftCardProvider {
  credentials: {
    NETWORK: Network;
    BITPAY_API_URL: string;
  } = {
    NETWORK: Network.livenet,
    BITPAY_API_URL: 'https://bitpay.com'
  };

  availableCardMapPromise: Promise<AvailableCardMap>;
  cachedApiCardConfigPromise: Promise<CardConfigMap>;

  cardUpdatesSubject: Subject<GiftCard> = new Subject<GiftCard>();
  cardUpdates$: Observable<GiftCard> = this.cardUpdatesSubject.asObservable();

  constructor(
    private configProvider: ConfigProvider,
    private emailNotificationsProvider: EmailNotificationsProvider,
    private http: HttpClient,
    private imageLoader: ImageLoader,
    private logger: Logger,
    private homeIntegrationsProvider: HomeIntegrationsProvider,
    private persistenceProvider: PersistenceProvider,
    private timeProvider: TimeProvider
  ) {
    this.logger.debug('GiftCardProvider initialized');
    this.setCredentials();
  }

  getNetwork() {
    return this.credentials.NETWORK;
  }

  setCredentials() {
    this.credentials.BITPAY_API_URL =
      this.credentials.NETWORK === Network.testnet
        ? 'https://test.bitpay.com'
        : 'https://bitpay.com';
  }

  async getCardConfig(cardName: string) {
    const supportedCards = await this.getSupportedCards();
    return supportedCards.find(c => c.name === cardName);
  }

  async getCardMap(cardName: string) {
    const network = this.getNetwork();
    const map = await this.persistenceProvider.getGiftCards(cardName, network);
    return map || {};
  }

  async getPurchasedCards(cardName: string): Promise<GiftCard[]> {
    const [cardConfig, giftCardMap] = await Promise.all([
      this.getCardConfig(cardName),
      this.getCardMap(cardName)
    ]);
    const invoiceIds = Object.keys(giftCardMap);
    const purchasedCards = invoiceIds
      .map(invoiceId => giftCardMap[invoiceId] as GiftCard)
      .filter(c => c.invoiceId)
      .map(c => ({
        ...c,
        name: cardName,
        displayName: cardConfig.displayName,
        currency: c.currency || getCurrencyFromLegacySavedCard(cardName)
      }))
      .sort(sortByDescendingDate);
    return purchasedCards;
  }

  async getAllCardsOfBrand(cardBrand: string): Promise<GiftCard[]> {
    const supportedCards = await this.getSupportedCards();
    const cardConfigs = supportedCards.filter(
      cardConfig => cardConfig.displayName === cardBrand
    );
    const cardPromises = cardConfigs.map(cardConfig =>
      this.getPurchasedCards(cardConfig.name)
    );
    const cardsGroup = await Promise.all(cardPromises);
    return cardsGroup
      .reduce((allCards, brandCards) => allCards.concat(brandCards), [])
      .sort(sortByDescendingDate);
  }

  async getPurchasedBrands(): Promise<GiftCard[][]> {
    const supportedCards = await this.getSupportedCards();
    const supportedCardNames = supportedCards.map(c => c.name);
    const purchasedCardPromises = supportedCardNames.map(cardName =>
      this.getPurchasedCards(cardName)
    );
    const purchasedCards = await Promise.all(purchasedCardPromises);
    return purchasedCards
      .filter(brand => brand.length)
      .sort((a, b) => sortByDisplayName(a[0], b[0]));
  }

  async saveCard(giftCard: GiftCard, opts?: GiftCardSaveParams) {
    const oldGiftCards = await this.getCardMap(giftCard.name);
    const newMap = this.getNewSaveableGiftCardMap(oldGiftCards, giftCard, opts);
    const savePromise = this.persistCards(giftCard.name, newMap);
    await Promise.all([savePromise, this.updateActiveCards([giftCard])]);
  }

  async updateActiveCards(giftCardsToUpdate: GiftCard[]) {
    const oldActiveGiftCards: GiftCardMap =
      (await this.persistenceProvider.getActiveGiftCards(this.getNetwork())) ||
      {};
    const newMap = giftCardsToUpdate.reduce(
      (updatedMap, c) =>
        this.getNewSaveableGiftCardMap(updatedMap, c, {
          remove: c.archived
        }),
      oldActiveGiftCards
    );
    return this.persistenceProvider.setActiveGiftCards(
      this.getNetwork(),
      JSON.stringify(newMap)
    );
  }

  persistCards(cardName: string, newMap: GiftCardMap) {
    return this.persistenceProvider.setGiftCards(
      cardName,
      this.getNetwork(),
      JSON.stringify(newMap)
    );
  }

  async saveGiftCard(giftCard: GiftCard, opts?: GiftCardSaveParams) {
    const originalCard = (await this.getPurchasedCards(giftCard.name)).find(
      c => c.invoiceId === giftCard.invoiceId
    );
    const cardChanged =
      !originalCard ||
      originalCard.status !== giftCard.status ||
      originalCard.archived !== giftCard.archived;
    const shouldNotify = cardChanged && giftCard.status !== 'UNREDEEMED';
    await this.saveCard(giftCard, opts);
    shouldNotify && this.cardUpdatesSubject.next(giftCard);
  }

  getNewSaveableGiftCardMap(oldGiftCards, gc, opts?): GiftCardMap {
    if (_.isString(oldGiftCards)) {
      oldGiftCards = JSON.parse(oldGiftCards);
    }
    if (_.isString(gc)) {
      gc = JSON.parse(gc);
    }
    let newMap = oldGiftCards || {};
    newMap[gc.invoiceId] = gc;
    if (opts && (opts.error || opts.status)) {
      newMap[gc.invoiceId] = _.assign(newMap[gc.invoiceId], opts);
    }
    if (opts && opts.remove) {
      delete newMap[gc.invoiceId];
    }
    return newMap;
  }

  async archiveCard(card: GiftCard) {
    card.archived = true;
    await this.saveGiftCard(card);
  }

  async unarchiveCard(card: GiftCard) {
    card.archived = false;
    await this.saveGiftCard(card);
  }

  async archiveAllCards(cardName: string) {
    const activeCards = (await this.getPurchasedCards(cardName)).filter(
      c => !c.archived
    );
    const oldGiftCards = await this.getCardMap(cardName);
    const invoiceIds = Object.keys(oldGiftCards);
    const newMap = invoiceIds.reduce((newMap, invoiceId) => {
      const card = oldGiftCards[invoiceId];
      card.archived = true;
      return this.getNewSaveableGiftCardMap(newMap, card);
    }, oldGiftCards);
    await Promise.all([
      this.persistCards(cardName, newMap),
      this.updateActiveCards(activeCards.map(c => ({ ...c, archived: true })))
    ]);
    activeCards
      .map(c => ({ ...c, archived: true }))
      .forEach(c => this.cardUpdatesSubject.next(c));
  }

  public async createGiftCard(data: GiftCard) {
    const dataSrc = {
      brand: data.name,
      clientId: data.uuid,
      invoiceId: data.invoiceId,
      accessKey: data.accessKey
    };

    const name = data.name;
    const cardConfig = await this.getCardConfig(name);

    const url = `${this.getApiPath()}/redeem`;

    return this.http
      .post(url, dataSrc)
      .catch(err => {
        this.logger.error(
          `${cardConfig.name} Gift Card Create/Update: ${err.message}`
        );
        const errMessage = err.error && err.error.message;
        const pendingMessages = [
          'Card creation delayed',
          'Invoice is unpaid or payment has not confirmed'
        ];
        return pendingMessages.indexOf(errMessage) > -1 ||
          errMessage.indexOf('Please wait') > -1
          ? of({ ...data, status: 'PENDING' })
          : Observable.throw(err);
      })
      .map((res: { claimCode?: string; claimLink?: string; pin?: string }) => {
        const status = res.claimCode || res.claimLink ? 'SUCCESS' : 'PENDING';
        const fullCard = {
          ...data,
          ...res,
          name,
          status
        };
        this.logger.info(
          `${cardConfig.name} Gift Card Create/Update: ${fullCard.status}`
        );
        return fullCard;
      })
      .toPromise();
  }

  updatePendingGiftCards(cards: GiftCard[]): Observable<GiftCard> {
    const cardsNeedingUpdate = cards.filter(card =>
      this.checkIfCardNeedsUpdate(card)
    );
    from(cardsNeedingUpdate)
      .pipe(
        mergeMap(card =>
          fromPromise(this.createGiftCard(card)).catch(err => {
            this.logger.error('Error creating gift card:', err);
            this.logger.error('Gift card: ', JSON.stringify(card, null, 4));
            return of({ ...card, status: 'FAILURE' });
          })
        ),
        mergeMap(card =>
          card.status === 'UNREDEEMED' || card.status === 'PENDING'
            ? fromPromise(
                this.getBitPayInvoice(card.invoiceId).then(invoice => ({
                  ...card,
                  status:
                    (card.status === 'PENDING' ||
                      (card.status === 'UNREDEEMED' &&
                        invoice.status !== 'new')) &&
                    invoice.status !== 'expired'
                      ? 'PENDING'
                      : 'expired'
                }))
              )
            : of(card)
        ),
        mergeMap(updatedCard => this.updatePreviouslyPendingCard(updatedCard))
      )
      .subscribe(_ => this.logger.debug('Gift card updated'));
    return this.cardUpdates$;
  }

  updatePreviouslyPendingCard(updatedCard: GiftCard) {
    return fromPromise(
      this.saveGiftCard(updatedCard, {
        remove: updatedCard.status === 'expired'
      })
    );
  }

  async createBitpayInvoice(data) {
    const dataSrc = {
      brand: data.cardName,
      currency: data.currency,
      amount: data.amount,
      clientId: data.uuid,
      email: data.email,
      transactionCurrency: data.buyerSelectedTransactionCurrency
    };
    const url = `${this.getApiPath()}/pay`;
    const headers = new HttpHeaders({
      'Content-Type': 'application/json'
    });
    const cardOrder = await this.http
      .post(url, dataSrc, { headers })
      .toPromise()
      .catch(err => {
        this.logger.error('BitPay Create Invoice: ERROR', JSON.stringify(data));
        throw err;
      });
    this.logger.info('BitPay Create Invoice: SUCCESS');
    return cardOrder as { accessKey: string; invoiceId: string };
  }

  public async getBitPayInvoice(id: string) {
    const res: any = await this.http
      .get(`${this.credentials.BITPAY_API_URL}/invoices/${id}`)
      .toPromise()
      .catch(err => {
        this.logger.error('BitPay Get Invoice: ERROR ' + err.error.message);
        throw err.error.message;
      });
    this.logger.info('BitPay Get Invoice: SUCCESS');
    return res.data;
  }

  private checkIfCardNeedsUpdate(card: GiftCard) {
    if (!card.invoiceId) {
      return false;
    }
    // Continues normal flow (update card)
    if (
      card.status === 'PENDING' ||
      card.status === 'UNREDEEMED' ||
      card.status === 'invalid' ||
      (!card.claimCode && !card.claimLink)
    ) {
      return true;
    }
    // Check if card status FAILURE for 24 hours
    if (
      card.status === 'FAILURE' &&
      this.timeProvider.withinPastDay(card.date)
    ) {
      return true;
    }
    // Success: do not update
    return false;
  }

  async getSupportedCards(): Promise<CardConfig[]> {
    const [availableCards, cachedApiCardConfig] = await Promise.all([
      this.getAvailableCards().catch(_ => [] as CardConfig[]),
      this.getCachedApiCardConfig().catch(_ => ({} as CardConfigMap))
    ]);
    const cachedCardNames = Object.keys(cachedApiCardConfig);
    const availableCardNames = availableCards.map(c => c.name);
    const uniqueCardNames = Array.from(
      new Set([...availableCardNames, ...cachedCardNames])
    );
    const supportedCards = uniqueCardNames
      .map(cardName => {
        const freshConfig = availableCards.find(c => c.name === cardName);
        const cachedConfig = appendFallbackImages(
          cachedApiCardConfig[cardName]
        );
        const config = freshConfig || cachedConfig;
        const displayName = config.displayName || config.brand || config.name;
        return {
          ...config,
          displayName
        } as CardConfig;
      })
      .sort(sortByDisplayName);
    return supportedCards;
  }

  async getSupportedCardMap(): Promise<CardConfigMap> {
    const supportedCards = await this.getSupportedCards();
    return supportedCards.reduce(
      (map, cardConfig) => ({
        ...map,
        [cardConfig.name]: cardConfig
      }),
      {}
    );
  }

  async getActiveCards(): Promise<GiftCard[]> {
    const giftCardMap = await this.persistenceProvider.getActiveGiftCards(
      this.getNetwork()
    );
    const supportedCards = await this.getSupportedCards();
    const offeredCardNames = supportedCards.map(c => c.name);
    const validSchema =
      giftCardMap && Object.keys(giftCardMap).every(key => key !== 'undefined');
    return !giftCardMap || !validSchema
      ? this.migrateAndFetchActiveCards()
      : Object.keys(giftCardMap)
          .map(invoiceId => giftCardMap[invoiceId] as GiftCard)
          .filter(card => offeredCardNames.indexOf(card.name) > -1)
          .filter(card => card.invoiceId)
          .sort(sortByDescendingDate);
  }

  async migrateAndFetchActiveCards(): Promise<GiftCard[]> {
    await this.persistenceProvider.setActiveGiftCards(Network.livenet, {});
    const purchasedBrands = await this.getPurchasedBrands();
    const activeCardsGroupedByBrand = purchasedBrands.filter(
      cards => cards.filter(c => !c.archived).length
    );
    const activeCards = activeCardsGroupedByBrand
      .reduce(
        (allCards, brandCards) => [...allCards, ...brandCards],
        [] as GiftCard[]
      )
      .filter(c => !c.archived);
    await this.updateActiveCards(activeCards);
    return activeCards;
  }

  async fetchAvailableCardMap() {
    const url = `${this.credentials.BITPAY_API_URL}/gift-cards/cards`;
    this.availableCardMapPromise = this.http.get(url).toPromise() as Promise<
      AvailableCardMap
    >;
    const availableCardMap = await this.availableCardMapPromise;
    this.cacheApiCardConfig(availableCardMap);
    return this.availableCardMapPromise;
  }

  async cacheApiCardConfig(availableCardMap: AvailableCardMap) {
    const cardNames = Object.keys(availableCardMap);
    const previousCache = await this.persistenceProvider.getGiftCardConfigCache();
    const apiCardConfigCache = getCardConfigFromApiConfigMap(
      availableCardMap
    ).reduce((configMap, apiCardConfigMap, index) => {
      const name = cardNames[index];
      return { ...configMap, [name]: apiCardConfigMap };
    }, {});
    const newCache = {
      ...previousCache,
      ...apiCardConfigCache
    };
    if (JSON.stringify(previousCache) !== JSON.stringify(newCache)) {
      await this.persistenceProvider.setGiftCardConfigCache(newCache);
    }
  }

  async fetchCachedApiCardConfig(): Promise<CardConfigMap> {
    this.cachedApiCardConfigPromise = this.persistenceProvider.getGiftCardConfigCache();
    return this.cachedApiCardConfigPromise;
  }

  async getCachedApiCardConfig(): Promise<CardConfigMap> {
    const config = this.cachedApiCardConfigPromise
      ? await this.cachedApiCardConfigPromise
      : await this.fetchCachedApiCardConfig();
    return config || {};
  }

  async getAvailableCardMap() {
    return this.availableCardMapPromise
      ? this.availableCardMapPromise
      : this.fetchAvailableCardMap();
  }

  async getAvailableCards(): Promise<CardConfig[]> {
    const availableCardMap = await this.getAvailableCardMap();
    const config = getCardConfigFromApiConfigMap(availableCardMap)
      .map(apiCardConfig => ({
        ...apiCardConfig,
        displayName: apiCardConfig.displayName || apiCardConfig.name
      }))
      .filter(
        cardConfig =>
          cardConfig.logo &&
          cardConfig.icon &&
          cardConfig.cardImage &&
          !cardConfig.hidden
      )
      .sort(sortByDisplayName);
    return config;
  }

  getApiPath() {
    return `${this.credentials.BITPAY_API_URL}/gift-cards`;
  }

  public emailIsValid(email: string): boolean {
    const validEmail = /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/.test(
      email
    );
    return validEmail;
  }

  public storeEmail(email: string): void {
    this.setUserInfo({ email });
  }

  public getUserEmail(): Promise<string> {
    return this.persistenceProvider
      .getGiftCardUserInfo()
      .then(data => {
        if (_.isString(data)) {
          data = JSON.parse(data);
        }
        return data && data.email
          ? data.email
          : this.emailNotificationsProvider.getEmailIfEnabled();
      })
      .catch(_ => {});
  }

  public async preloadImages(): Promise<void> {
    const supportedCards = await this.getSupportedCards();
    const imagesPerCard = supportedCards
      .map(c => [c.icon, c.cardImage])
      .filter(images => images[0] && images[1]);
    const fetchBatches = imagesPerCard.map(images => async () =>
      Promise.all(images.map(i => this.imageLoader.preload(i)))
    );
    await promiseSerial(fetchBatches);
  }

  private setUserInfo(data: any): void {
    this.persistenceProvider.setGiftCardUserInfo(JSON.stringify(data));
  }

  public register() {
    this.homeIntegrationsProvider.register({
      name: 'giftcards',
      title: 'Gift Cards',
      icon: 'assets/img/gift-cards/gift-cards-icon.svg',
      show: !!this.configProvider.get().showIntegration['giftcards']
    });
  }
}

function getCardConfigFromApiConfigMap(availableCardMap: AvailableCardMap) {
  const cardNames = Object.keys(availableCardMap);
  return cardNames
    .filter(
      cardName =>
        availableCardMap[cardName] && availableCardMap[cardName].length
    )
    .map(cardName =>
      getCardConfigFromApiBrandConfig(cardName, availableCardMap[cardName])
    );
}

function getCardConfigFromApiBrandConfig(
  cardName: string,
  apiBrandConfig: ApiCardConfig
): CardConfig {
  const cards = apiBrandConfig;
  const [firstCard] = cards;
  const { currency } = firstCard;
  const range = cards.find(
    c => !!(c.maxAmount || c.minAmount) && c.currency === currency
  );
  const fixed = cards.filter(c => c.amount && c.currency);
  const supportedAmounts = fixed
    .reduce(
      (newSupportedAmounts, currentCard) => [
        ...newSupportedAmounts,
        currentCard.amount
      ],
      []
    )
    .sort((a, b) => a - b);

  const { amount, type, maxAmount, minAmount, ...config } = firstCard;
  const baseConfig = { ...config, name: cardName };

  return range
    ? {
        ...baseConfig,
        minAmount: range.minAmount < 1 ? 1 : range.minAmount,
        maxAmount: range.maxAmount
      }
    : { ...baseConfig, supportedAmounts };
}

export function sortByDescendingDate(a: GiftCard, b: GiftCard) {
  return a.date < b.date ? 1 : -1;
}

export function sortByDisplayName(
  a: CardConfig | GiftCard,
  b: CardConfig | GiftCard
) {
  return a.displayName > b.displayName ? 1 : -1;
}

function appendFallbackImages(cardConfig: CardConfig) {
  // For cards bought outside of the user's current IP catalog area before server-side
  // catalog management was implemented and card images were stored locally.
  const getBrandImagePath = brandName => {
    const cardImagePath = `https://bitpay.com/gift-cards/assets/`;
    const brandImageDirectory = brandName
      .toLowerCase()
      .replace(/[^0-9a-z]/gi, '');
    return `${cardImagePath}${brandImageDirectory}/`;
  };
  const getImagesForBrand = brandName => {
    const imagePath = getBrandImagePath(brandName);
    return {
      cardImage: `${imagePath}card.png`,
      icon: `${imagePath}icon.svg`,
      logo: `${imagePath}logo.svg`
    };
  };
  const needsFallback =
    cardConfig &&
    cardConfig.cardImage &&
    !cardConfig.cardImage.includes('https://bitpay.com');
  return needsFallback
    ? { ...cardConfig, ...getImagesForBrand(cardConfig.name) }
    : cardConfig;
}

function getCurrencyFromLegacySavedCard(
  cardName: string
): 'USD' | 'JPY' | 'BRL' {
  switch (cardName) {
    case 'Amazon.com':
      return 'USD';
    case 'Amazon.co.jp':
      return 'JPY';
    case 'Mercado Livre':
      return 'BRL';
    default:
      return 'USD';
  }
}
