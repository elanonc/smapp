import {
  catchError,
  delay,
  first,
  forkJoin,
  from,
  interval,
  map,
  Observable,
  pairwise,
  retry,
  startWith,
  Subject,
  switchMap,
  withLatestFrom,
} from 'rxjs';
import { dissocPath, equals, of } from 'ramda';
import { ipcConsts } from '../../../app/vars';
import { Network, NodeConfig, Wallet } from '../../../shared/types';
import {
  fetchNetworksFromDiscovery,
  generateGenesisIDFromConfig,
  listPublicApis,
} from '../Networks';
import { handleIPC, handlerResult, makeSubscription } from '../rx.utils';
import { fetchNodeConfig } from '../../utils';
import { Managers } from '../app.types';
import Logger from '../../logger';

const logger = Logger({ className: 'fetchDiscovery' });

export const fromNetworkConfig = (net: Network) => {
  logger.log('fromNetworkConfig', { net });
  return from(fetchNodeConfig(net.conf)).pipe(
    retry(3),
    delay(200),
    catchError(() => {
      return of([]);
    })
  );
};

export const withGenesisID = () =>
  switchMap((networks: Network[]) =>
    forkJoin([
      ...networks.map(
        (net) => fromNetworkConfig(net) as Observable<NodeConfig>
      ),
    ]).pipe(
      map((configs) => {
        return networks.map(
          (net, i): Network => ({
            ...net,
            genesisID: generateGenesisIDFromConfig(configs[i]),
          })
        );
      })
    )
  );

const fromDiscovery = () =>
  from(fetchNetworksFromDiscovery())
    .pipe(
      retry(3),
      delay(200),
      catchError(() => of([]))
    )
    .pipe(withGenesisID());
export const fetchDiscovery = ($networks: Subject<Network[]>) =>
  makeSubscription(fromDiscovery(), (nets) => $networks.next(nets));

export const fetchDiscoveryEach = (
  period: number,
  $networks: Subject<Network[]>
) =>
  makeSubscription(
    interval(period).pipe(switchMap(fromDiscovery)),
    (nets) => nets.length > 0 && $networks.next(nets)
  );

export const listNetworksByRequest = ($networks: Subject<Network[]>) =>
  makeSubscription(
    handleIPC(
      ipcConsts.LIST_NETWORKS,
      () => fromDiscovery().pipe(map((nets) => handlerResult(nets))),
      (nets) => nets
    ),
    (networks) => $networks.next(networks)
  );

export const listenNodeConfigAndRestartNode = (
  $nodeConfig: Observable<NodeConfig>,
  $managers: Subject<Managers>
) =>
  makeSubscription(
    $nodeConfig.pipe(startWith(null), pairwise(), withLatestFrom($managers)),
    ([[prevNodeConfig, nextNodeConfig], managers]) => {
      (async () => {
        // Do not restart the Node if...
        // A. it's a first Config ever
        if (prevNodeConfig === null) return;
        // B. configs are equal
        if (equals(prevNodeConfig, nextNodeConfig)) return;
        // C. Node is not running
        if (!managers.node.isNodeRunning()) return;
        // D. if User only turned smeshing off (and the rest config not changed)
        if (
          prevNodeConfig?.smeshing?.['smeshing-start'] === true &&
          nextNodeConfig?.smeshing?.['smeshing-start'] === false &&
          equals(
            dissocPath(['smeshing', 'smeshing-start'], prevNodeConfig),
            dissocPath(['smeshing', 'smeshing-start'], nextNodeConfig)
          )
        )
          return;

        // In other cases — restart the Node
        logger.log(
          'listenNodeConfigAndRestartNode',
          'Node config changed. Restart the Node'
        );
        await managers.node.restartNode();
      })();
    }
  );

export const listPublicApisByRequest = ($wallet: Subject<Wallet | null>) =>
  makeSubscription(
    handleIPC(
      ipcConsts.LIST_PUBLIC_SERVICES,
      (selectedGenesisID: string) =>
        fromDiscovery().pipe(
          withLatestFrom($wallet),
          first(),
          map(([nets, wallet]) => {
            const net = nets.find(
              (n) =>
                n.genesisID === wallet?.meta.genesisID ||
                n.genesisID === selectedGenesisID
            );
            return handlerResult(listPublicApis(net || null));
          })
        ),
      (apis) => apis
    ),
    (_) => {}
  );
