import { BigNumber, BigNumberish } from '@ethersproject/bignumber';
import { ContractTransaction } from '@ethersproject/contracts';
import { CONVERTUSDC, OptionType, PositionState, toBN } from '@scripts/util/web3utils';
import { assertCloseToPercentage } from '../../../utils/assert';
import {
  ALL_TYPES,
  closePositionWithOverrides,
  compareTradeResults,
  duplicateOrders,
  openPositionWithOverrides,
  orderWithCumulativeResults,
} from '../../../utils/contractHelpers';
import { getRoutedFunds6dp } from '../../../utils/contractHelpers/fees';
import { mineBlock, restoreSnapshot, takeSnapshot } from '../../../utils/evm';
import { seedFixtureUSDCwBTC } from '../../../utils/fixture';
import { createDefaultBoardWithOverrides, mockPrice } from '../../../utils/seedTestSystem';
import { expect, hre } from '../../../utils/testSetup';

describe('USDC_quote - Successful Close', async () => {
  const collaterals = [toBN('0'), toBN('0'), toBN('1'), toBN('1500'), toBN('1500')];
  const closeAmount = toBN('0.0001');
  let positionId: BigNumber;
  let DEFAULT_PARAM: {
    positionId: BigNumber;
    optionType: OptionType;
    strikeId: BigNumberish;
    amount: BigNumber;
    setCollateralTo: BigNumber;
  };
  let oldUserQuoteBal: BigNumber;
  let oldOMBalance: BigNumber;

  beforeEach(async () => {
    await seedFixtureUSDCwBTC();
  });

  // check for each "it":
  //      - expect("updates exposure");
  //      - expect("LP sends funds to user");
  //      - expect("SC funds remain unchanged");
  //      - expect("checks proper lockedCollateral changes")

  ALL_TYPES.forEach(async optionType => {
    describe('trade: ' + OptionType[optionType], async () => {
      beforeEach(async () => {
        [, positionId] = await openPositionWithOverrides(hre.f.c, {
          optionType: optionType,
          strikeId: hre.f.strike.strikeId,
          amount: toBN('1'),
          setCollateralTo: collaterals[optionType],
        });
        DEFAULT_PARAM = {
          positionId: positionId,
          optionType: optionType,
          strikeId: hre.f.strike.strikeId,
          amount: toBN('1'),
          setCollateralTo: collaterals[optionType],
        };

        oldUserQuoteBal = await hre.f.c.snx.quoteAsset.balanceOf(hre.f.deployer.address);
        oldOMBalance = await hre.f.c.snx.quoteAsset.balanceOf(hre.f.c.optionMarket.address);
      });

      ['0.0001', '1000'].forEach(async price => {
        it('closes 0.0001 amount @ base price: ' + price, async () => {
          // open amount = 1
          await createDefaultBoardWithOverrides(hre.f.c, { strikePrices: [price, price, price] });
          await mockPrice(hre.f.c, toBN(price), 'sETH');

          [, positionId] = await openPositionWithOverrides(hre.f.c, {
            optionType: optionType,
            strikeId: 4,
            amount: closeAmount,
            setCollateralTo: collaterals[optionType],
          });

          const oldBalance = await hre.f.c.snx.quoteAsset.balanceOf(hre.f.deployer.address);

          await closePositionWithOverrides(hre.f.c, {
            positionId: positionId,
            optionType: optionType,
            strikeId: 4,
            amount: closeAmount,
            setCollateralTo: 0,
          });
          const newBalance = await hre.f.c.snx.quoteAsset.balanceOf(hre.f.deployer.address);

          if (price == '0.0001') {
            if (optionType == OptionType.SHORT_CALL_BASE) {
              assertCloseToPercentage(oldBalance, newBalance); // assert close due to rounding
              expect(oldBalance).to.lt(newBalance.add(100)); // variance fee
            } else if (optionType == OptionType.SHORT_CALL_QUOTE || optionType == OptionType.SHORT_PUT_QUOTE) {
              assertCloseToPercentage(oldBalance.add(collaterals[optionType].div(CONVERTUSDC)), newBalance);
            } else {
              expect(oldBalance).to.eq(newBalance); // variance fee
            }
          } else {
            if (optionType == OptionType.SHORT_CALL_BASE) {
              expect(oldBalance).to.gt(newBalance); // variance fee
              expect(oldBalance).to.lt(newBalance.add(100e6)); // variance fee
            } else if (optionType == OptionType.SHORT_CALL_QUOTE || optionType == OptionType.SHORT_PUT_QUOTE) {
              expect(oldBalance.add(collaterals[optionType].div(CONVERTUSDC))).to.gt(newBalance);
              expect(oldBalance.add(collaterals[optionType].div(CONVERTUSDC))).to.lt(newBalance.add(100e6)); // variance fee
            } else {
              expect(oldBalance).to.lt(newBalance); // variance fee
              expect(oldBalance.add(100e6)).to.gt(newBalance); // variance fee
            }
          }

          await expectStateAndAmount(positionId, PositionState.CLOSED, toBN('0'));
        });
      });

      it('close 0 amount', async () => {
        const tx = await closePositionWithOverrides(hre.f.c, {
          ...DEFAULT_PARAM,
          amount: 0,
          setCollateralTo: collaterals[optionType],
        });

        await expectRoutedFundsOnClose6dp(
          tx,
          hre.f.deployer.address,
          oldUserQuoteBal,
          oldOMBalance,
          toBN('0'),
          optionType,
        );
        await expectStateAndAmount(positionId, PositionState.ACTIVE, toBN('1'));
      });

      it('reduce amount', async () => {
        const tx = await closePositionWithOverrides(hre.f.c, {
          ...DEFAULT_PARAM,
          amount: toBN('0.5'),
          setCollateralTo: collaterals[optionType].div(2),
        });

        await expectStateAndAmount(positionId, PositionState.ACTIVE, toBN('0.5'));
        await expectRoutedFundsOnClose6dp(
          tx,
          hre.f.deployer.address,
          oldUserQuoteBal,
          oldOMBalance,
          collaterals[optionType].div(2),
          optionType,
        );

        const interimUserBalance = await hre.f.c.snx.quoteAsset.balanceOf(hre.f.deployer.address);
        const interimOMBalance = await hre.f.c.snx.quoteAsset.balanceOf(hre.f.c.optionMarket.address);

        // fully close
        const secondTx = await closePositionWithOverrides(hre.f.c, {
          ...DEFAULT_PARAM,
          amount: toBN('0.5'),
          setCollateralTo: 0,
        });

        await expectRoutedFundsOnClose6dp(
          secondTx,
          hre.f.deployer.address,
          interimUserBalance,
          interimOMBalance,
          collaterals[optionType].div(2),
          optionType,
        );
        await expectStateAndAmount(positionId, PositionState.CLOSED, toBN('0'));
      });
      it('charges same cost for 3 iterations and 3 orders', async () => {
        [, positionId] = await openPositionWithOverrides(hre.f.c, {
          ...DEFAULT_PARAM,
          positionId: 0,
          amount: toBN('30'),
          setCollateralTo: collaterals[optionType].mul(30),
        });

        // open 30 options with 3 separate orders
        await mineBlock();
        const snapshot = await takeSnapshot();
        const duplicateOrderResult = await duplicateOrders(
          3,
          optionType,
          hre.f.strike.strikeId,
          toBN('10'),
          toBN('0'),
          false,
          positionId,
        );
        await restoreSnapshot(snapshot);

        // open 30 options with one order but 3 iterations
        const iteratedOrderResult = await orderWithCumulativeResults(
          3,
          optionType,
          hre.f.strike.strikeId,
          toBN('30'),
          toBN('0'),
          false,
          positionId,
        );
        compareTradeResults(duplicateOrderResult, iteratedOrderResult);
      });
      it('cannot be adjusted by another user', async () => {
        const [, positionId] = await openPositionWithOverrides(hre.f.c, {
          optionType: optionType,
          strikeId: hre.f.strike.strikeId,
          amount: toBN('1'),
          setCollateralTo: collaterals[optionType],
        });
        await expect(
          closePositionWithOverrides(
            hre.f.c,
            {
              positionId: positionId,
              optionType: optionType,
              strikeId: hre.f.strike.strikeId,
              amount: toBN('1'),
              setCollateralTo: 0,
            },
            hre.f.alice,
          ),
        ).revertedWith('OnlyOwnerCanAdjustPosition');
      });
    });
  });
});

export async function expectStateAndAmount(positionId: BigNumberish, state: PositionState, amount: BigNumber) {
  const position = await hre.f.c.optionToken.getOptionPosition(positionId);
  expect(position.state).to.eq(state);
  expect(position.amount).to.eq(amount);
}

export async function expectRoutedFundsOnClose6dp(
  tx: ContractTransaction,
  user: string,
  oldUserQuoteBal: BigNumber,
  oldOMBalance: BigNumber,
  collateral: BigNumber,
  optionType: OptionType,
) {
  const newUserBalance = await hre.f.c.snx.quoteAsset.balanceOf(user);
  const newOMBalance = await hre.f.c.snx.quoteAsset.balanceOf(hre.f.c.optionMarket.address);
  const funds = await getRoutedFunds6dp(tx, false);
  collateral = collateral.div(CONVERTUSDC);

  if (optionType == OptionType.SHORT_CALL_QUOTE || optionType == OptionType.SHORT_PUT_QUOTE) {
    // expect(oldUserQuoteBal.add(collateral).sub(funds.userDiff)).to.eq(newUserBalance);
    assertCloseToPercentage(oldUserQuoteBal.add(collateral).sub(funds.userDiff), newUserBalance);
  } else if (optionType == OptionType.SHORT_CALL_BASE) {
    // expect(oldUserQuoteBal.sub(funds.userDiff)).to.eq(newUserBalance);
    assertCloseToPercentage(oldUserQuoteBal.sub(funds.userDiff), newUserBalance);
  } else {
    assertCloseToPercentage(oldUserQuoteBal.add(funds.userDiff), newUserBalance);
  }
  assertCloseToPercentage(newOMBalance.sub(oldOMBalance), funds.optionMarketDiff);
}
