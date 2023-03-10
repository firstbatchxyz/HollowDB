import ArLocal from 'arlocal';
import {LoggerFactory, Warp, WarpFactory} from 'warp-contracts';
import {DeployPlugin} from 'warp-contracts-plugin-deploy';
import initialState from '../common/initialState';
import fs from 'fs';
import path from 'path';
import {SDK, Admin, Prover} from '../src';
import type {CacheType} from '../src/sdk/types';
import poseidon from 'poseidon-lite';
import {randomBytes} from 'crypto';
import {prepareSDKs} from './utils';

// WASM and prover key for generating proofs
const WASM_PATH = './circuits/hollow-authz/hollow-authz.wasm';
const PROVERKEY_PATH = './circuits/hollow-authz/prover_key.zkey';

// arbitrarily long timeout
jest.setTimeout(30000);

enum PublicSignal {
  CurValueHash = 0,
  NextValueHash = 1,
  Key = 2,
}

const ARWEAVE_PORT = 3169;

describe('hollowdb', () => {
  let arlocal: ArLocal;
  let contractSource: string;
  let prover: Prover;

  beforeAll(async () => {
    arlocal = new ArLocal(ARWEAVE_PORT, false);
    await arlocal.start();

    LoggerFactory.INST.logLevel('error');

    contractSource = fs.readFileSync(path.join(__dirname, '../build/hollowDB/contract.js'), 'utf8');

    prover = new Prover(WASM_PATH, PROVERKEY_PATH);
  });

  describe.each<CacheType>(['lmdb', 'redis'])('using %s cache, proofs enabled', cacheType => {
    let ownerAdmin: Admin;
    let ownerSDK: SDK;
    let aliceSDK: SDK;
    let warp: Warp;

    const KEY_PREIMAGE = BigInt('0x' + randomBytes(10).toString('hex'));
    const KEY = poseidon([KEY_PREIMAGE]).toString();
    const VALUE_TX = randomBytes(10).toString('hex');
    const NEXT_VALUE_TX = randomBytes(10).toString('hex');

    beforeAll(async () => {
      // setup warp factory for local arweave
      warp = WarpFactory.forLocal(ARWEAVE_PORT).use(new DeployPlugin());

      // get accounts
      const ownerWallet = await warp.generateWallet();
      const aliceWallet = await warp.generateWallet();

      // deploy contract
      const {contractTxId: hollowDBTxId} = await Admin.deploy(
        ownerWallet.jwk,
        initialState,
        contractSource,
        warp,
        true // bundling is disabled during testing
      );
      console.log('Deployed contract: ', hollowDBTxId);

      // prepare SDKs
      [ownerAdmin, ownerSDK, aliceSDK] = prepareSDKs(cacheType, warp, hollowDBTxId, ownerWallet.jwk, aliceWallet.jwk);

      const contractTx = await warp.arweave.transactions.get(hollowDBTxId);
      expect(contractTx).not.toBeNull();
    });

    it('should succesfully deploy with correct state', async () => {
      const {cachedValue} = await ownerSDK.readState();
      expect(cachedValue.state.verificationKey).toEqual({});
      expect(cachedValue.state.isProofRequired).toEqual(true);
      expect(cachedValue.state.isWhitelistRequired.put).toEqual(false);
      expect(cachedValue.state.isWhitelistRequired.update).toEqual(false);
      expect(cachedValue.state.owner).toEqual(await warp.arweave.wallets.getAddress(ownerAdmin.jwk));
    });

    describe('admin operations', () => {
      let verificationKey: object;

      beforeAll(() => {
        verificationKey = JSON.parse(
          fs.readFileSync(path.join(__dirname, '../circuits/hollow-authz/verification_key.json'), 'utf8')
        );
      });

      it('should set verification key', async () => {
        await ownerAdmin.setVerificationKey(verificationKey);
        const {cachedValue} = await ownerSDK.readState();
        expect(cachedValue.state.verificationKey).toEqual(verificationKey);
      });
    });

    describe('put operations', () => {
      it('should put a value to a key & read it', async () => {
        expect(await ownerSDK.get(KEY)).toEqual(null);
        await ownerSDK.put(KEY, VALUE_TX);
        expect(await ownerSDK.get(KEY)).toEqual(VALUE_TX);
      });

      it('should NOT put a value to the same key', async () => {
        await expect(ownerSDK.put(KEY, VALUE_TX)).rejects.toThrow(
          'Contract Error [put]: Key already exists, use update instead'
        );
      });

      it('should put many values', async () => {
        const count = 10;
        const values = Array<string>(count).fill(randomBytes(10).toString('hex'));

        for (let i = 0; i < values.length; ++i) {
          const k = KEY + i;
          const v = values[i];
          expect(await ownerSDK.get(k)).toEqual(null);
          await ownerSDK.put(k, v);
          expect(await ownerSDK.get(k)).toEqual(v);
        }
      });
    });

    describe('update operations', () => {
      let proof: object;

      beforeAll(async () => {
        const currentValue = (await aliceSDK.get(KEY)) as string;
        const fullProof = await prover.generateProof(KEY_PREIMAGE, currentValue, NEXT_VALUE_TX);
        proof = fullProof.proof;
        expect(prover.valueToBigInt(currentValue).toString()).toEqual(
          fullProof.publicSignals[PublicSignal.CurValueHash]
        );
        expect(prover.valueToBigInt(NEXT_VALUE_TX).toString()).toEqual(
          fullProof.publicSignals[PublicSignal.NextValueHash]
        );
        expect(KEY).toEqual(fullProof.publicSignals[PublicSignal.Key]);
      });

      it('should NOT update with a proof using wrong current value', async () => {
        // generate a proof with wrong next value
        const fullProof = await prover.generateProof(KEY_PREIMAGE, 'abcdefg', NEXT_VALUE_TX);
        await expect(aliceSDK.update(KEY, NEXT_VALUE_TX, fullProof.proof)).rejects.toThrow();
      });

      it('should NOT update with a proof using wrong next value', async () => {
        // generate a proof with wrong next value
        const fullProof = await prover.generateProof(KEY_PREIMAGE, VALUE_TX, 'abcdefg');
        await expect(aliceSDK.update(KEY, NEXT_VALUE_TX, fullProof.proof)).rejects.toThrow();
      });

      it('should NOT update with a proof using wrong preimage', async () => {
        // generate a proof with wrong preimage
        const fullProof = await prover.generateProof(1234567n, VALUE_TX, NEXT_VALUE_TX);
        await expect(aliceSDK.update(KEY, NEXT_VALUE_TX, fullProof.proof)).rejects.toThrow();
      });

      it('should NOT update an existing value without a proof', async () => {
        await expect(aliceSDK.update(KEY, NEXT_VALUE_TX, {})).rejects.toThrow();
      });

      it('should update an existing value with proof', async () => {
        await aliceSDK.update(KEY, NEXT_VALUE_TX, proof);
        expect(await aliceSDK.get(KEY)).toEqual(NEXT_VALUE_TX);
      });

      it('should NOT update an existing value with the same proof', async () => {
        await expect(aliceSDK.update(KEY, NEXT_VALUE_TX, proof)).rejects.toThrow(
          'Contract Error [update]: Proof verification failed in: update'
        );
      });
    });

    describe('remove operations', () => {
      let proof: object;

      beforeAll(async () => {
        const currentValue = (await aliceSDK.get(KEY)) as string;
        const fullProof = await prover.generateProof(KEY_PREIMAGE, currentValue, null);
        proof = fullProof.proof;

        expect(prover.valueToBigInt(currentValue).toString()).toEqual(
          fullProof.publicSignals[PublicSignal.CurValueHash]
        );
        expect(KEY).toEqual(fullProof.publicSignals[PublicSignal.Key]);
      });

      it('should remove an existing value with proof', async () => {
        expect(await aliceSDK.get(KEY)).not.toEqual(null);
        await aliceSDK.remove(KEY, proof);
        expect(await aliceSDK.get(KEY)).toEqual(null);
      });

      it('should NOT remove an already remove value with proof', async () => {
        expect(await aliceSDK.get(KEY)).toEqual(null);
        await expect(aliceSDK.remove(KEY, proof)).rejects.toThrow('Key does not exist');
      });
    });

    describe('tests with proofs disabled', () => {
      const KEY_PREIMAGE = BigInt('0x' + randomBytes(10).toString('hex'));
      const KEY = poseidon([KEY_PREIMAGE]).toString();
      const VALUE_TX = randomBytes(10).toString('hex');
      const NEXT_VALUE_TX = randomBytes(10).toString('hex');

      // disable proofs
      beforeAll(async () => {
        const {cachedValue} = await ownerSDK.readState();
        expect(cachedValue.state.isProofRequired).toEqual(true);

        await ownerAdmin.setProofRequirement(false);

        const {cachedValue: newCachedValue} = await ownerSDK.readState();
        expect(newCachedValue.state.isProofRequired).toEqual(false);
      });

      it('should put a value to a key & read it', async () => {
        expect(await ownerSDK.get(KEY)).toEqual(null);
        await ownerSDK.put(KEY, VALUE_TX);
        expect(await ownerSDK.get(KEY)).toEqual(VALUE_TX);
      });

      it('should update an existing value without proof', async () => {
        await aliceSDK.update(KEY, NEXT_VALUE_TX);
        expect(await aliceSDK.get(KEY)).toEqual(NEXT_VALUE_TX);
      });

      it('should remove an existing value without proof', async () => {
        expect(await aliceSDK.get(KEY)).not.toEqual(null);
        await aliceSDK.remove(KEY);
        expect(await aliceSDK.get(KEY)).toEqual(null);
      });

      describe('tests with whitelisting', () => {
        let aliceAddress: string;

        const KEY_PREIMAGE = BigInt('0x' + randomBytes(10).toString('hex'));
        const KEY = poseidon([KEY_PREIMAGE]).toString();
        const VALUE_TX = randomBytes(10).toString('hex');
        const NEXT_VALUE_TX = randomBytes(10).toString('hex');

        beforeAll(async () => {
          // enabe whitelisting
          const {cachedValue: oldCachedValue} = await ownerSDK.readState();
          expect(oldCachedValue.state.isWhitelistRequired.put).toEqual(false);
          expect(oldCachedValue.state.isWhitelistRequired.update).toEqual(false);
          await ownerAdmin.setWhitelistRequirement({
            put: true,
            update: true,
          });
          const {cachedValue: newCachedValue} = await ownerSDK.readState();
          expect(newCachedValue.state.isWhitelistRequired.put).toEqual(true);
          expect(newCachedValue.state.isWhitelistRequired.update).toEqual(true);

          // get address of user to be whitelisted
          aliceAddress = await warp.arweave.wallets.getAddress(aliceSDK.jwk);
        });

        it('should NOT put/update/remove when NOT whitelisted', async () => {
          await expect(aliceSDK.put(KEY, VALUE_TX)).rejects.toThrow(
            'Contract Error [put]: User is not whitelisted for: put'
          );
          await expect(aliceSDK.update(KEY, NEXT_VALUE_TX, {})).rejects.toThrow(
            'Contract Error [update]: User is not whitelisted for: update'
          );
          await expect(aliceSDK.remove(KEY, {})).rejects.toThrow(
            'Contract Error [remove]: User is not whitelisted for: remove'
          );
        });

        it('should whitelist user Alice', async () => {
          const {cachedValue: oldCachedValue} = await aliceSDK.readState();
          expect(oldCachedValue.state.whitelist.put).not.toHaveProperty(aliceAddress);
          expect(oldCachedValue.state.whitelist.update).not.toHaveProperty(aliceAddress);

          await ownerAdmin.addUsersToWhitelist([aliceAddress], 'put');
          await ownerAdmin.addUsersToWhitelist([aliceAddress], 'update');

          const {cachedValue: newCachedValue} = await aliceSDK.readState();
          expect(newCachedValue.state.whitelist.put).toHaveProperty(aliceAddress);
          expect(newCachedValue.state.whitelist.update).toHaveProperty(aliceAddress);
          expect(newCachedValue.state.whitelist.put[aliceAddress]).toEqual(true);
          expect(newCachedValue.state.whitelist.update[aliceAddress]).toEqual(true);
        });

        it('should put/update/remove when whitelisted', async () => {
          await aliceSDK.put(KEY, VALUE_TX);
          await aliceSDK.update(KEY, NEXT_VALUE_TX, {});
          await aliceSDK.remove(KEY, {});
        });

        it('should remove whitelisted user Alice', async () => {
          const {cachedValue} = await aliceSDK.readState();
          expect(cachedValue.state.whitelist.put).toHaveProperty(aliceAddress);
          expect(cachedValue.state.whitelist.update).toHaveProperty(aliceAddress);
          expect(cachedValue.state.whitelist.put[aliceAddress]).toEqual(true);
          expect(cachedValue.state.whitelist.update[aliceAddress]).toEqual(true);

          await ownerAdmin.removeUsersFromWhitelist([aliceAddress], 'put');
          await ownerAdmin.removeUsersFromWhitelist([aliceAddress], 'update');

          const {cachedValue: newCachedValue} = await aliceSDK.readState();
          expect(newCachedValue.state.whitelist.put).not.toHaveProperty(aliceAddress);
          expect(newCachedValue.state.whitelist.update).not.toHaveProperty(aliceAddress);
        });

        afterAll(async () => {
          // disable whitelisting
          const {cachedValue: oldCachedValue} = await ownerSDK.readState();
          expect(oldCachedValue.state.isWhitelistRequired.put).toEqual(true);
          expect(oldCachedValue.state.isWhitelistRequired.update).toEqual(true);

          await ownerAdmin.setWhitelistRequirement({
            put: false,
            update: false,
          });

          const {cachedValue: newCachedValue} = await ownerSDK.readState();
          expect(newCachedValue.state.isWhitelistRequired.put).toEqual(false);
          expect(newCachedValue.state.isWhitelistRequired.update).toEqual(false);
        });
      });

      afterAll(async () => {
        // enable proofs
        const {cachedValue: oldCachedValue} = await ownerSDK.readState();
        expect(oldCachedValue.state.isProofRequired).toEqual(false);

        await ownerAdmin.setProofRequirement(true);

        const {cachedValue: newCachedValue} = await ownerSDK.readState();
        expect(newCachedValue.state.isProofRequired).toEqual(true);
      });
    });
  });

  afterAll(async () => {
    await arlocal.stop();
  });
});
