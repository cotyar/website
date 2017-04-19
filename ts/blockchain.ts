import * as _ from 'lodash';
import * as Web3 from 'web3';
import {Dispatcher} from 'ts/redux/dispatcher';
import {Provider} from 'ts/provider';
import {utils} from 'ts/utils/utils';
import {Ox} from 'ts/utils/Ox';
import {constants} from 'ts/utils/constants';
import {BlockchainErrs, Token, SignatureData, Side} from 'ts/types';
import {Web3Wrapper} from 'ts/web3_wrapper';
import {errorReporter} from 'ts/utils/error_reporter';
import {tradeHistoryStorage} from 'ts/local_storage/trade_history_storage';
import {customTokenStorage} from 'ts/local_storage/custom_token_storage';
import * as ProxyArtifacts from '../contracts/Proxy.json';
import * as ExchangeArtifacts from '../contracts/Exchange.json';
import * as TokenRegistryArtifacts from '../contracts/TokenRegistry.json';
import * as TokenArtifacts from '../contracts/Token.json';
import * as MintableArtifacts from '../contracts/Mintable.json';
import contract = require('truffle-contract');
import BigNumber = require('bignumber.js');
import ethUtil = require('ethereumjs-util');

const MINT_AMOUNT = new BigNumber('100000000000000000000');

export class Blockchain {
    public networkId: number;
    private dispatcher: Dispatcher;
    private web3Wrapper: Web3Wrapper;
    private provider: Provider;
    private exchange: any; // TODO: add type definition for Contract
    private exchangeLogFillEvents: any[];
    private proxy: any;
    private tokenRegistry: any;
    private userAddress: string;
    constructor(dispatcher: Dispatcher) {
        this.dispatcher = dispatcher;
        this.userAddress = '';
        this.exchangeLogFillEvents = [];
        this.onPageLoadInitFireAndForgetAsync();
    }
    public async networkIdUpdatedFireAndForgetAsync(newNetworkId: number) {
        const isConnected = !_.isUndefined(newNetworkId);
        if (!isConnected) {
            this.networkId = newNetworkId;
            this.dispatcher.encounteredBlockchainError(BlockchainErrs.DISCONNECTED_FROM_ETHEREUM_NODE);
            this.dispatcher.updateShouldBlockchainErrDialogBeOpen(true);
        } else if (this.networkId !== newNetworkId) {
            this.networkId = newNetworkId;
            this.dispatcher.encounteredBlockchainError('');
            await this.instantiateContractsAsync();
            await this.rehydrateStoreWithContractEvents();
        }
    }
    public async userAddressUpdatedFireAndForgetAsync(newUserAddress: string) {
        if (this.userAddress !== newUserAddress) {
            this.userAddress = newUserAddress;
            await this.rehydrateStoreWithContractEvents();
        }
    }
    public async setExchangeAllowanceAsync(token: Token, amountInBaseUnits: BigNumber) {
        if (!this.isValidAddress(token.address)) {
            throw new Error('tokenAddress is not a valid address');
        }
        if (!this.doesUserAddressExist()) {
            throw new Error('Cannot set allowance if no user accounts accessible');
        }
        const tokenContract = await this.instantiateContractIfExistsAsync(TokenArtifacts, token.address);
        await tokenContract.approve(this.proxy.address, amountInBaseUnits, {
            from: this.userAddress,
        });
        token.allowance = amountInBaseUnits;
        this.dispatcher.updateTokenByAddress([token]);
    }
    public async isValidSignatureAsync(maker: string, signatureData: SignatureData) {
      if (!this.doesUserAddressExist()) {
          throw new Error('Cannot check for validSignature if no user accounts accessible');
      }

      const isValidSignature = await this.exchange.isValidSignature.call(
        maker,
        signatureData.hash,
        signatureData.v,
        signatureData.r,
        signatureData.s,
        {
          from: this.userAddress,
        },
      );
      return isValidSignature;
    }
    public async fillOrderAsync(maker: string, taker: string, makerTokenAddress: string,
                                takerTokenAddress: string, makerTokenAmount: BigNumber,
                                takerTokenAmount: BigNumber, expirationUnixTimestampSec: number,
                                fillAmount: BigNumber, signatureData: SignatureData) {
        if (!this.doesUserAddressExist()) {
            throw new Error('Cannot fill order if no user accounts accessible');
        }

        taker = taker === '' ? constants.NULL_ADDRESS : taker;
        const shouldCheckTransfer = true;
        const fill = {
            expiration: expirationUnixTimestampSec,
            feeRecipient: constants.FEE_RECIPIENT_ADDRESS,
            fees: [constants.MAKER_FEE, constants.TAKER_FEE],
            fillValueM: fillAmount.toString(),
            rs: [signatureData.r, signatureData.s],
            tokens: [makerTokenAddress, takerTokenAddress],
            traders: [maker, taker],
            shouldCheckTransfer,
            v: signatureData.v,
            values: [makerTokenAmount.toString(), takerTokenAmount.toString()],
        };
        await this.exchange.fill(fill.traders,
                                 fill.tokens,
                                 fill.feeRecipient,
                                 fill.shouldCheckTransfer,
                                 fill.values,
                                 fill.fees,
                                 fill.expiration,
                                 fill.fillValueM,
                                 fill.v,
                                 fill.rs, {
                                      from: this.userAddress,
                                  });
    }
    public async getFillAmountAsync(orderHash: string) {
        utils.assert(Ox.isValidOrderHash(orderHash), 'Must be valid orderHash');
        const fillAmount = await this.exchange.fills.call(orderHash);
        return fillAmount.toNumber();
    }
    public getExchangeContractAddressIfExists() {
        return this.exchange ? this.exchange.address : undefined;
    }
    public isValidAddress(address: string): boolean {
        const lowercaseAddress = address.toLowerCase();
        return this.web3Wrapper.call('isAddress', [lowercaseAddress]);
    }
    public async sendSignRequestAsync(orderHashHex: string): Promise<SignatureData> {
        const orderHashBuff = new Buffer(orderHashHex.substring(2), 'hex');
        const msgHashBuff = ethUtil.hashPersonalMessage(orderHashBuff);
        const msgHashHex = ethUtil.bufferToHex(msgHashBuff);
        const makerAddress = this.userAddress;
        // If makerAddress is undefined, this means they have a web3 instance injected into their browser
        // but no account addresses associated with it.
        if (_.isUndefined(makerAddress)) {
            throw new Error('Tried to send a sign request but user has no associated addresses');
        }
        const signature = await this.web3Wrapper.signTransactionAsync(makerAddress, msgHashHex);
        const signatureData = {
            hash: orderHashHex,
            r: `0x${signature.substring(2, 66)}`,
            s: `0x${signature.substring(66, 130)}`,
            v: _.parseInt(signature.substring(130, 132)) + 27,
        };
        this.dispatcher.updateSignatureData(signatureData);
        return signatureData;
    }
    public async mintTestTokensAsync(token: Token) {
        if (!this.doesUserAddressExist()) {
            throw new Error('User has no associated addresses');
        }
        const mintableContract = await this.instantiateContractIfExistsAsync(MintableArtifacts, token.address);
        await mintableContract.mint(MINT_AMOUNT, {
            from: this.userAddress,
        });
        const tokens = [_.assign({}, token, {
            balance: token.balance.plus(MINT_AMOUNT),
        })];
        this.dispatcher.updateTokenByAddress(tokens);
    }
    public async doesContractExistAtAddressAsync(address: string) {
        return await this.web3Wrapper.doesContractExistAtAddressAsync(address);
    }
    public async getTokenBalanceAndAllowanceAsync(tokenAddress: string): Promise<BigNumber[]> {
        const tokenContract = await this.instantiateContractIfExistsAsync(TokenArtifacts, tokenAddress);
        let balance;
        let allowance;
        if (this.doesUserAddressExist()) {
            balance = await tokenContract.balanceOf.call(this.userAddress);
            allowance = await tokenContract.allowance.call(this.userAddress, this.proxy.address);
        }
        balance = _.isUndefined(balance) ? new BigNumber(0) : balance;
        allowance = _.isUndefined(allowance) ? new BigNumber(0) : allowance;
        return [balance, allowance];
    }
    public async updateTokenBalancesAndAllowancesAsync(tokens: Token[]) {
        const updatedTokens = [];
        for (const token of tokens) {
            if (_.isUndefined(token.address)) {
                continue; // Cannot retrieve balance for tokens without an address
            }
            const [balance, allowance] = await this.getTokenBalanceAndAllowanceAsync(token.address);
            updatedTokens.push(_.assign({}, token, {
                balance,
                allowance,
            }));
        }
        this.dispatcher.updateTokenByAddress(updatedTokens);
    }
    private doesUserAddressExist(): boolean {
        return this.userAddress !== '';
    }
    private async rehydrateStoreWithContractEvents() {
        // Ensure we are only ever listening to one set of events
        this.stopWatchingExchangeLogFillEvents();

        if (!this.doesUserAddressExist()) {
            return; // short-circuit
        }

        if (!_.isUndefined(this.exchange)) {
            // Since we do not have an index on the `taker` address and want to show
            // transactions where an account is either the `maker` or `taker`, we loop
            // through all fill events, and filter/cache them client-side.
            const filterIndexObj = {};
            this.startListeningForExchangeLogFillEvents(filterIndexObj);
        }
    }
    private startListeningForExchangeLogFillEvents(filterIndexObj: object) {
        utils.assert(!_.isUndefined(this.exchange), 'Exchange contract must be instantiated.');
        utils.assert(this.doesUserAddressExist(), 'User must have address available.');

        const fromBlock = tradeHistoryStorage.getFillsLatestBlock(this.userAddress);
        const exchangeLogFillEvent = this.exchange.LogFill(filterIndexObj, {
            fromBlock,
            toBlock: 'latest',
        });
        exchangeLogFillEvent.watch((err: Error, result: any) => {
            if (err) {
                // Note: it's not entirely clear from the documentation which
                // errors will be thrown by `watch`. For now, let's log the error
                // to rollbar and stop watching when one occurs
                errorReporter.reportAsync(err); // fire and forget
                this.stopWatchingExchangeLogFillEvents();
                return;
            } else {
                const args = result.args;
                const isBlockPending = _.isNull(args.blockNumber);
                if (!isBlockPending) {
                    tradeHistoryStorage.setFillsLatestBlock(this.userAddress, result.blockNumber);
                }
                const isUserMakerOrTaker = args.maker === this.userAddress || args.taker === this.userAddress;
                if (!isUserMakerOrTaker) {
                    return; // We aren't interested in the fill event
                }
                const fill = {
                    expiration: args.expiration.toNumber(),
                    filledValueM: args.filledValueM.toNumber(),
                    logIndex: result.logIndex,
                    maker: args.maker,
                    orderHash: args.orderHash,
                    taker: args.taker,
                    tokenM: args.tokenM,
                    tokenT: args.tokenT,
                    transactionHash: result.transactionHash,
                    valueM: args.valueM.toNumber(),
                    valueT: args.valueT.toNumber(),
                };
                tradeHistoryStorage.addFillToUser(this.userAddress, fill);
            }
        });
        this.exchangeLogFillEvents.push(exchangeLogFillEvent);
    }
    private stopWatchingExchangeLogFillEvents() {
        if (!_.isEmpty(this.exchangeLogFillEvents)) {
            _.each(this.exchangeLogFillEvents, (logFillEvent) => {
                logFillEvent.stopWatching();
            });
            this.exchangeLogFillEvents = [];
        }
    }
    private async getTokenRegistryTokensAsync() {
        if (this.tokenRegistry) {
            const addresses = await this.tokenRegistry.getTokenAddresses.call();
            const tokens = [];
            for (const address of addresses) {
                const [balance, allowance] = await this.getTokenBalanceAndAllowanceAsync(address);
                const [
                  tokenAddress,
                  name,
                  symbol,
                  url,
                  decimals,
                ] = await this.tokenRegistry.getTokenMetaData.call(address);
                const token: Token = {
                    address,
                    allowance,
                    balance,
                    name,
                    symbol,
                    decimals: decimals.toNumber(),
                };
                // HACK: For now we have a hard-coded list of iconUrls for the dummyTokens
                // TODO: Refactor this out and pull the iconUrl directly from the TokenRegistry
                const iconUrl = constants.iconUrlBySymbol[symbol];
                if (!_.isUndefined(iconUrl)) {
                    token.iconUrl = iconUrl;
                }
                tokens.push(token);
            }
            return tokens;
        } else {
            return [];
        }
    }
    private async getCustomTokensAsync() {
        const customTokens = customTokenStorage.getCustomTokens(this.networkId);
        for (const customToken of customTokens) {
            const [balance, allowance] = await this.getTokenBalanceAndAllowanceAsync(customToken.address);
            customToken.balance = balance;
            customToken.allowance = allowance;
        }
        return customTokens;
    }
    private async onPageLoadInitFireAndForgetAsync() {
        await this.onPageLoadAsync(); // wait for page to load

        // Once page loaded, we can instantiate provider
        this.provider = new Provider();

        const web3Instance = new Web3();
        web3Instance.setProvider(this.provider.getProviderObj());
        this.web3Wrapper = new Web3Wrapper(web3Instance, this.dispatcher);
    }
    private async instantiateContractsAsync() {
        utils.assert(!_.isUndefined(this.networkId),
                     'Cannot call instantiateContractsAsync if disconnected from Ethereum node');

        this.dispatcher.updateBlockchainIsLoaded(false);
        try {
            this.exchange = await this.instantiateContractIfExistsAsync(ExchangeArtifacts);
            this.tokenRegistry = await this.instantiateContractIfExistsAsync(TokenRegistryArtifacts);
            this.proxy = await this.instantiateContractIfExistsAsync(ProxyArtifacts);
        } catch (err) {
            const errMsg = err + '';
            if (_.includes(errMsg, 'CONTRACT_DOES_NOT_EXIST')) {
                this.dispatcher.encounteredBlockchainError(BlockchainErrs.A_CONTRACT_NOT_DEPLOYED_ON_NETWORK);
                this.dispatcher.updateShouldBlockchainErrDialogBeOpen(true);
            } else {
                // We show a generic message for other possible caught errors
                this.dispatcher.encounteredBlockchainError(BlockchainErrs.UNHANDLED_ERROR);
            }
        }
        this.dispatcher.clearTokenByAddress();
        let tokens = await this.getTokenRegistryTokensAsync();
        const customTokens = await this.getCustomTokensAsync();
        tokens = [...tokens, ...customTokens];
        this.dispatcher.updateTokenByAddress(tokens);
        this.dispatcher.updateChosenAssetTokenAddress(Side.deposit, tokens[0].address);
        this.dispatcher.updateChosenAssetTokenAddress(Side.receive, tokens[1].address);
        this.dispatcher.updateBlockchainIsLoaded(true);
    }
    private async instantiateContractIfExistsAsync(artifact: any, address?: string) {
        const c = await contract(artifact);
        c.setProvider(this.provider.getProviderObj());

        const artifactNetworkConfigs = artifact.networks[this.networkId];
        let contractAddress;
        if (!_.isUndefined(address)) {
            contractAddress = address;
        } else if (!_.isUndefined(artifactNetworkConfigs)) {
            contractAddress = artifactNetworkConfigs.address;
        }

        if (!_.isUndefined(contractAddress)) {
            const doesContractExist = await this.doesContractExistAtAddressAsync(contractAddress);
            if (!doesContractExist) {
                throw new Error('CONTRACT_DOES_NOT_EXIST');
            }
        }

        try {
            let contractInstance;
            if (_.isUndefined(address)) {
                contractInstance = await c.deployed();
            } else {
                contractInstance = await c.at(address);
            }
            return contractInstance;
        } catch (err) {
            const errMsg = `${err}`;
            utils.consoleLog(`Notice: Error encountered: ${err} ${err.stack}`);
            if (_.includes(errMsg, 'not been deployed to detected network')) {
                throw new Error('CONTRACT_DOES_NOT_EXIST');
            } else {
                await errorReporter.reportAsync(err);
                throw new Error('UNHANDLED_ERROR');
            }
        }
    }
    private async onPageLoadAsync() {
        return new Promise((resolve, reject) => {
            window.onload = resolve;
        });
    }
}
