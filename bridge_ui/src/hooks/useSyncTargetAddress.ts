import {
  canonicalAddress,
  CHAIN_ID_ALGORAND,
  CHAIN_ID_NEAR,
  CHAIN_ID_SOLANA,
  isEVMChain,
  isTerraChain,
  uint8ArrayToHex,
} from "@certusone/wormhole-sdk";
import { arrayify, zeroPad } from "@ethersproject/bytes";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  Token,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { useConnectedWallet } from "@terra-money/wallet-provider";
import { useEffect } from "react";
import { useDispatch, useSelector } from "react-redux";
import { useAlgorandContext } from "../contexts/AlgorandWalletContext";
import { useEthereumProvider } from "../contexts/EthereumProviderContext";
import { useSolanaWallet } from "../contexts/SolanaWalletContext";
import { setTargetAddressHex as setNFTTargetAddressHex } from "../store/nftSlice";
import {
  selectNFTTargetAsset,
  selectNFTTargetChain,
  selectTransferTargetAsset,
  selectTransferTargetChain,
  selectTransferTargetParsedTokenAccount,
} from "../store/selectors";
import { setTargetAddressHex as setTransferTargetAddressHex } from "../store/transferSlice";
import { decodeAddress } from "algosdk";
import { useNearContext } from "../contexts/NearWalletContext";
import { makeNearAccount, signAndSendTransactions } from "../utils/near";
import { NEAR_TOKEN_BRIDGE_ACCOUNT } from "../utils/consts";
import { getTransactionLastResult } from "near-api-js/lib/providers";
import BN from "bn.js";

function useSyncTargetAddress(shouldFire: boolean, nft?: boolean) {
  const dispatch = useDispatch();
  const targetChain = useSelector(
    nft ? selectNFTTargetChain : selectTransferTargetChain
  );
  const { signerAddress } = useEthereumProvider();
  const solanaWallet = useSolanaWallet();
  const solPK = solanaWallet?.publicKey;
  const targetAsset = useSelector(
    nft ? selectNFTTargetAsset : selectTransferTargetAsset
  );
  const targetParsedTokenAccount = useSelector(
    selectTransferTargetParsedTokenAccount
  );
  const targetTokenAccountPublicKey = targetParsedTokenAccount?.publicKey;
  const terraWallet = useConnectedWallet();
  const { accounts: algoAccounts } = useAlgorandContext();
  const { accountId: nearAccountId, wallet } = useNearContext();
  const setTargetAddressHex = nft
    ? setNFTTargetAddressHex
    : setTransferTargetAddressHex;
  useEffect(() => {
    if (shouldFire) {
      let cancelled = false;
      if (isEVMChain(targetChain) && signerAddress) {
        dispatch(
          setTargetAddressHex(
            uint8ArrayToHex(zeroPad(arrayify(signerAddress), 32))
          )
        );
      }
      // TODO: have the user explicitly select an account on solana
      else if (
        !nft && // only support existing, non-derived token accounts for token transfers (nft flow doesn't check balance)
        targetChain === CHAIN_ID_SOLANA &&
        targetTokenAccountPublicKey
      ) {
        // use the target's TokenAccount if it exists
        dispatch(
          setTargetAddressHex(
            uint8ArrayToHex(
              zeroPad(new PublicKey(targetTokenAccountPublicKey).toBytes(), 32)
            )
          )
        );
      } else if (targetChain === CHAIN_ID_SOLANA && solPK && targetAsset) {
        // otherwise, use the associated token account (which we create in the case it doesn't exist)
        (async () => {
          try {
            const associatedTokenAccount =
              await Token.getAssociatedTokenAddress(
                ASSOCIATED_TOKEN_PROGRAM_ID,
                TOKEN_PROGRAM_ID,
                new PublicKey(targetAsset), // this might error
                solPK
              );
            if (!cancelled) {
              dispatch(
                setTargetAddressHex(
                  uint8ArrayToHex(zeroPad(associatedTokenAccount.toBytes(), 32))
                )
              );
            }
          } catch (e) {
            if (!cancelled) {
              dispatch(setTargetAddressHex(undefined));
            }
          }
        })();
      } else if (
        isTerraChain(targetChain) &&
        terraWallet &&
        terraWallet.walletAddress
      ) {
        dispatch(
          setTargetAddressHex(
            uint8ArrayToHex(
              zeroPad(canonicalAddress(terraWallet.walletAddress), 32)
            )
          )
        );
      } else if (targetChain === CHAIN_ID_ALGORAND && algoAccounts[0]) {
        dispatch(
          setTargetAddressHex(
            uint8ArrayToHex(decodeAddress(algoAccounts[0].address).publicKey)
          )
        );
      } else if (targetChain === CHAIN_ID_NEAR && nearAccountId && wallet) {
        (async () => {
          try {
            const account = await makeNearAccount(nearAccountId);
            // So, near can have account names up to 64 bytes but wormhole can only have 32...
            //   as a result, we have to hash our account names to sha256's..  What we are doing
            //   here is doing a RPC call (does not require any interaction with the wallet and is free)
            //   that both tells us our account hash AND if we are already registered...
            let account_hash = await account.viewFunction(
              NEAR_TOKEN_BRIDGE_ACCOUNT,
              "hash_account",
              {
                account: nearAccountId,
              }
            );
            if (!cancelled) {
              let myAddress = account_hash[1];
              console.log("account hash for", nearAccountId, account_hash);

              if (!account_hash[0]) {
                console.log("Registering the receiving account");

                let myAddress2 = getTransactionLastResult(
                  await signAndSendTransactions(account, wallet, [
                    {
                      contractId: NEAR_TOKEN_BRIDGE_ACCOUNT,
                      methodName: "register_account",
                      args: { account: nearAccountId },
                      gas: new BN("100000000000000"),
                      attachedDeposit: new BN("2000000000000000000000"), // 0.002 NEAR
                    },
                  ])
                );

                console.log("account hash returned: " + myAddress2);
              } else {
                console.log("account already registered");
              }
              if (!cancelled) {
                dispatch(setTargetAddressHex(myAddress));
              }
            }
          } catch (e) {
            console.log(e);
            if (!cancelled) {
              dispatch(setTargetAddressHex(undefined));
            }
          }
        })();
      } else {
        dispatch(setTargetAddressHex(undefined));
      }
      return () => {
        cancelled = true;
      };
    }
  }, [
    dispatch,
    shouldFire,
    targetChain,
    signerAddress,
    solPK,
    targetAsset,
    targetTokenAccountPublicKey,
    terraWallet,
    nft,
    setTargetAddressHex,
    algoAccounts,
    nearAccountId,
    wallet,
  ]);
}

export default useSyncTargetAddress;
