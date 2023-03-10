import type {HollowDBState} from '../contracts/hollowDB/types';

const initialState: HollowDBState = {
  owner: '',
  verificationKey: {},
  isProofRequired: true,
  canEvolve: true,
  whitelist: {
    put: {},
    update: {},
  },
  isWhitelistRequired: {
    put: false,
    update: false,
  },
};

export default initialState;
