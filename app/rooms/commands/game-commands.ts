import { Command } from "@colyseus/command"
import { Client, updateLobby } from "colyseus"
import { nanoid } from "nanoid"

import {
  ConditionBasedEvolutionRule,
  CountEvolutionRule,
  HatchEvolutionRule
} from "../../core/evolution-rules"
import { selectMatchups } from "../../core/matchmaking"
import { canSell } from "../../core/pokemon-entity"
import Simulation from "../../core/simulation"
import { getLevelUpCost } from "../../models/colyseus-models/experience-manager"
import Player from "../../models/colyseus-models/player"
import { isOnBench, PokemonClasses } from "../../models/colyseus-models/pokemon"
import { createRandomEgg } from "../../models/egg-factory"
import PokemonFactory from "../../models/pokemon-factory"
import { PVEStages } from "../../models/pve-stages"
import { getBuyPrice, getSellPrice } from "../../models/shop"
import { getAvatarString } from "../../public/src/utils"
import {
  IClient,
  IDragDropCombineMessage,
  IDragDropItemMessage,
  IDragDropMessage,
  Title,
  Transfer
} from "../../types"
import {
  AdditionalPicksStages,
  FIGHTING_PHASE_DURATION,
  ITEM_CAROUSEL_BASE_DURATION,
  ItemCarouselStages,
  ItemProposalStages,
  MAX_PLAYERS_PER_GAME,
  PORTAL_CAROUSEL_BASE_DURATION,
  PortalCarouselStages,
  StageDuration,
  SynergyTriggers
} from "../../types/Config"
import { Effect } from "../../types/enum/Effect"
import { BattleResult, GamePhaseState, Team } from "../../types/enum/Game"
import {
  ArtificialItems,
  Berries,
  FishingRods,
  Item,
  ItemComponents,
  ItemRecipe,
  NonHoldableItems,
  ShinyItems,
  SynergyGivenByItem,
  SynergyItems
} from "../../types/enum/Item"
import { Passive } from "../../types/enum/Passive"
import {
  Pkm,
  PkmIndex,
  PkmRegionalVariants,
  Unowns
} from "../../types/enum/Pokemon"
import { SpecialGameRule } from "../../types/enum/SpecialGameRule"
import { Synergy } from "../../types/enum/Synergy"
import { removeInArray } from "../../utils/array"
import {
  getFirstAvailablePositionInBench,
  getFirstAvailablePositionOnBoard,
  getFreeSpaceOnBench,
  getMaxTeamSize,
  isPositionEmpty
} from "../../utils/board"
import { repeat } from "../../utils/function"
import { logger } from "../../utils/logger"
import { max, min } from "../../utils/number"
import { chance, pickNRandomIn, pickRandomIn } from "../../utils/random"
import { resetArraySchema, values } from "../../utils/schemas"
import { getWeather } from "../../utils/weather"
import GameRoom from "../game-room"

export class OnShopCommand extends Command<
  GameRoom,
  {
    playerId: string
    index: number
  }
> {
  execute({ playerId, index }) {
    if (
      playerId === undefined ||
      index === undefined ||
      !this.state.players.has(playerId)
    )
      return
    const player = this.state.players.get(playerId)
    if (!player || !player.shop[index] || player.shop[index] === Pkm.DEFAULT)
      return

    const name = player.shop[index]
    const pokemon = PokemonFactory.createPokemonFromName(name, player)
    const isEvolution =
      pokemon.evolutionRule &&
      pokemon.evolutionRule instanceof CountEvolutionRule &&
      pokemon.evolutionRule.canEvolveIfBuyingOne(pokemon, player)

    let cost = getBuyPrice(name, this.state.specialGameRule)
    const freeSpaceOnBench = getFreeSpaceOnBench(player.board)
    const hasSpaceOnBench = freeSpaceOnBench > 0 || isEvolution

    if (
      isEvolution &&
      this.state.specialGameRule === SpecialGameRule.BUYER_FEVER
    ) {
      cost = 0
    }

    const canBuy = player.money >= cost && hasSpaceOnBench
    if (!canBuy) return

    player.money -= cost

    const x = getFirstAvailablePositionInBench(player.board)
    pokemon.positionX = x !== undefined ? x : -1
    pokemon.positionY = 0
    player.board.set(pokemon.id, pokemon)
    pokemon.onAcquired(player)

    if (
      pokemon.passive === Passive.UNOWN &&
      player.shop.every((p) => Unowns.includes(p))
    ) {
      // reset shop after picking in a unown shop
      this.state.shop.assignShop(player, true, this.state)
      player.shopFreeRolls -= 1
    } else {
      player.shop = player.shop.with(index, Pkm.DEFAULT)
    }

    this.room.checkEvolutionsAfterPokemonAcquired(playerId)
  }
}

export class OnRemoveFromShopCommand extends Command<
  GameRoom,
  {
    playerId: string
    index: number
  }
> {
  execute({ playerId, index }) {
    if (
      playerId === undefined ||
      index === undefined ||
      !this.state.players.has(playerId)
    )
      return
    const player = this.state.players.get(playerId)
    if (!player || !player.shop[index] || player.shop[index] === Pkm.DEFAULT)
      return

    const name = player.shop[index]
    const cost = getBuyPrice(name, this.state.specialGameRule)
    if (player.money >= cost) {
      player.shop = player.shop.with(index, Pkm.DEFAULT)
      player.shopLocked = true
      this.state.shop.releasePokemon(name, player)
    }
  }
}

export class OnPokemonCatchCommand extends Command<
  GameRoom,
  {
    playerId: string
    pkm: Pkm
  }
> {
  execute({ playerId, pkm }) {
    if (
      playerId === undefined ||
      pkm === undefined ||
      !this.state.players.has(playerId)
    )
      return
    const player = this.state.players.get(playerId)
    if (!player) return

    const pokemon = PokemonFactory.createPokemonFromName(pkm, player)
    const freeSpaceOnBench = getFreeSpaceOnBench(player.board)
    const hasSpaceOnBench =
      freeSpaceOnBench > 0 ||
      (pokemon.evolutionRule &&
        pokemon.evolutionRule instanceof CountEvolutionRule &&
        pokemon.evolutionRule.canEvolveIfBuyingOne(pokemon, player))

    if (hasSpaceOnBench) {
      const x = getFirstAvailablePositionInBench(player.board)
      pokemon.positionX = x !== undefined ? x : -1
      pokemon.positionY = 0
      player.board.set(pokemon.id, pokemon)
      pokemon.onAcquired(player)
      this.room.checkEvolutionsAfterPokemonAcquired(playerId)
    }
  }
}

export class OnDragDropCommand extends Command<
  GameRoom,
  {
    client: IClient
    detail: IDragDropMessage
  }
> {
  execute({ client, detail }) {
    const commands = []
    let success = false
    let dittoReplaced = false
    const message = {
      updateBoard: true,
      updateItems: true
    }
    const playerId = client.auth.uid
    const player = this.state.players.get(playerId)

    if (player) {
      message.updateItems = false
      const pokemon = player.board.get(detail.id)
      if (pokemon) {
        const { x, y } = detail
        const dropOnBench = y == 0
        const dropFromBench = isOnBench(pokemon)

        if (
          pokemon.name === Pkm.DITTO &&
          dropFromBench &&
          !isPositionEmpty(x, y, player.board)
        ) {
          const pokemonToClone = this.room.getPokemonByPosition(player, x, y)
          if (pokemonToClone && pokemonToClone.canBeCloned) {
            dittoReplaced = true
            const replaceDitto = PokemonFactory.createPokemonFromName(
              PokemonFactory.getPokemonBaseEvolution(pokemonToClone.name),
              player
            )
            pokemon.items.forEach((item) => {
              player.items.push(item)
            })
            player.board.delete(detail.id)
            const position = getFirstAvailablePositionInBench(player.board)
            if (position !== undefined) {
              replaceDitto.positionX = position
              replaceDitto.positionY = 0
              player.board.set(replaceDitto.id, replaceDitto)
              success = true
              message.updateBoard = false
            }
          } else if (y === 0) {
            this.room.swap(player, pokemon, x, y)
            success = true
          }
        } else if (dropOnBench && dropFromBench) {
          // Drag and drop pokemons through bench has no limitation

          this.room.swap(player, pokemon, x, y)
          pokemon.onChangePosition(x, y, player)
          success = true
        } else if (this.state.phase == GamePhaseState.PICK) {
          // On pick, allow to drop on / from board
          const teamSize = this.room.getTeamSize(player.board)
          const isBoardFull =
            teamSize >=
            getMaxTeamSize(
              player.experienceManager.level,
              this.room.state.specialGameRule
            )
          const dropToEmptyPlace = isPositionEmpty(x, y, player.board)

          if (dropOnBench) {
            // From board to bench is always allowed (bench to bench is already handled)
            this.room.swap(player, pokemon, x, y)
            pokemon.onChangePosition(x, y, player)
            success = true
          } else if (
            pokemon.canBePlaced &&
            !(dropFromBench && dropToEmptyPlace && isBoardFull)
          ) {
            // Prevents a pokemon to go on the board only if it's adding a pokemon from the bench on a full board
            this.room.swap(player, pokemon, x, y)
            pokemon.onChangePosition(x, y, player)
            success = true
          }
        }
      }

      if (!success && client.send) {
        client.send(Transfer.DRAG_DROP_FAILED, message)
      }
      if (dittoReplaced) {
        this.room.checkEvolutionsAfterPokemonAcquired(playerId)
      }

      player.updateSynergies()
      player.boardSize = this.room.getTeamSize(player.board)
    }
    if (commands.length > 0) {
      return commands
    }
  }
}

export class OnSwitchBenchAndBoardCommand extends Command<
  GameRoom,
  {
    client: Client
    pokemonId: string
  }
> {
  execute({ client, pokemonId }) {
    const playerId = client.auth.uid
    const player = this.room.state.players.get(playerId)
    if (!player) return

    const pokemon = player.board.get(pokemonId)
    if (!pokemon) return

    if (this.state.phase !== GamePhaseState.PICK) return // can't switch pokemons if not in pick phase

    if (pokemon.positionY === 0) {
      // pokemon is on bench, switch to board
      const teamSize = this.room.getTeamSize(player.board)
      const isBoardFull =
        teamSize >=
        getMaxTeamSize(
          player.experienceManager.level,
          this.room.state.specialGameRule
        )
      const destination = getFirstAvailablePositionOnBoard(player.board)
      if (pokemon.canBePlaced && destination && !isBoardFull) {
        const [dx, dy] = destination

        this.room.swap(player, pokemon, dx, dy)
        pokemon.onChangePosition(dx, dy, player)
      }
    } else {
      // pokemon is on board, switch to bench
      const dx = getFirstAvailablePositionInBench(player.board)
      if (dx !== undefined) {
        this.room.swap(player, pokemon, dx, 0)
        pokemon.onChangePosition(dx, 0, player)
      }
    }

    player.updateSynergies()
    player.boardSize = this.room.getTeamSize(player.board)
  }
}

export class OnDragDropCombineCommand extends Command<
  GameRoom,
  {
    client: Client
    detail: IDragDropCombineMessage
  }
> {
  execute({ client, detail }) {
    const playerId = client.auth.uid
    const message = {
      updateBoard: true,
      updateItems: true
    }
    const player = this.state.players.get(playerId)

    if (player) {
      message.updateBoard = false
      message.updateItems = true

      const itemA = detail.itemA
      const itemB = detail.itemB

      //verify player has both items
      if (!player.items.includes(itemA) || !player.items.includes(itemB)) {
        client.send(Transfer.DRAG_DROP_FAILED, message)
        return
      }
      // check for two if both items are same
      else if (itemA == itemB) {
        let count = 0
        player.items.forEach((item) => {
          if (item == itemA) {
            count++
          }
        })

        if (count < 2) {
          client.send(Transfer.DRAG_DROP_FAILED, message)
          return
        }
      }

      // find recipe result
      let result: Item | undefined = undefined
      for (const [key, value] of Object.entries(ItemRecipe) as [
        Item,
        Item[]
      ][]) {
        if (
          (value[0] == itemA && value[1] == itemB) ||
          (value[0] == itemB && value[1] == itemA)
        ) {
          result = key
          break
        }
      }

      if (!result) {
        client.send(Transfer.DRAG_DROP_FAILED, message)
        return
      } else {
        player.items.push(result)
        removeInArray(player.items, itemA)
        removeInArray(player.items, itemB)
      }

      player.updateSynergies()
    }
  }
}
export class OnDragDropItemCommand extends Command<
  GameRoom,
  {
    client: Client
    detail: IDragDropItemMessage
  }
> {
  execute({ client, detail }) {
    const playerId = client.auth.uid
    const message = {
      updateBoard: true,
      updateItems: true
    }
    const player = this.state.players.get(playerId)
    if (!player) return

    message.updateBoard = false
    message.updateItems = true

    const { x, y, id: item } = detail

    if (!player.items.includes(item)) {
      client.send(Transfer.DRAG_DROP_FAILED, message)
      return
    }

    let pokemon = player.getPokemonAt(x, y)
    if (pokemon === undefined) {
      client.send(Transfer.DRAG_DROP_FAILED, message)
      return
    }

    if (item === Item.METEORITE) {
      if (pokemon?.passive === Passive.ALIEN_DNA) {
        if (pokemon.name === Pkm.DEOXYS) {
          player.transformPokemon(pokemon, Pkm.DEOXYS_ATTACK)
        } else if (pokemon.name === Pkm.DEOXYS_ATTACK) {
          player.transformPokemon(pokemon, Pkm.DEOXYS_DEFENSE)
        } else if (pokemon.name === Pkm.DEOXYS_DEFENSE) {
          player.transformPokemon(pokemon, Pkm.DEOXYS_SPEED)
        } else if (pokemon.name === Pkm.DEOXYS_SPEED) {
          player.transformPokemon(pokemon, Pkm.DEOXYS)
        }
      }
      client.send(Transfer.DRAG_DROP_FAILED, message)
      return
    }

    if (
      item === Item.TEAL_MASK ||
      item === Item.WELLSPRING_MASK ||
      item === Item.HEARTHFLAME_MASK ||
      item === Item.CORNERSTONE_MASK
    ) {
      if (
        pokemon.passive === Passive.OGERPON_TEAL ||
        pokemon.passive === Passive.OGERPON_WELLSPRING ||
        pokemon.passive === Passive.OGERPON_HEARTHFLAME ||
        pokemon.passive === Passive.OGERPON_CORNERSTONE
      ) {
        if (pokemon.passive === Passive.OGERPON_TEAL) {
          pokemon.items.delete(Item.TEAL_MASK)
        } else if (pokemon.passive === Passive.OGERPON_WELLSPRING) {
          pokemon.items.delete(Item.WELLSPRING_MASK)
        } else if (pokemon.passive === Passive.OGERPON_HEARTHFLAME) {
          pokemon.items.delete(Item.HEARTHFLAME_MASK)
        } else if (pokemon.passive === Passive.OGERPON_CORNERSTONE) {
          pokemon.items.delete(Item.CORNERSTONE_MASK)
        }

        if (item === Item.TEAL_MASK) {
          pokemon.items.add(Item.TEAL_MASK)
          player.transformPokemon(pokemon, Pkm.OGERPON_TEAL_MASK)
        } else if (item === Item.WELLSPRING_MASK) {
          pokemon.items.add(Item.WELLSPRING_MASK)
          player.transformPokemon(pokemon, Pkm.OGERPON_WELLSPRING_MASK)
        } else if (item === Item.HEARTHFLAME_MASK) {
          pokemon.items.add(Item.HEARTHFLAME_MASK)
          player.transformPokemon(pokemon, Pkm.OGERPON_HEARTHFLAME_MASK)
        } else if (item === Item.CORNERSTONE_MASK) {
          pokemon.items.add(Item.CORNERSTONE_MASK)
          player.transformPokemon(pokemon, Pkm.OGERPON_CORNERSTONE_MASK)
        }
      } else {
        client.send(Transfer.DRAG_DROP_FAILED, message)
        return
      }
    }

    if (item === Item.FIRE_SHARD) {
      if (pokemon.types.has(Synergy.FIRE) && player.life > 3) {
        pokemon.atk += 3
        player.life = min(1)(player.life - 3)
        removeInArray(player.items, item)
      }
      client.send(Transfer.DRAG_DROP_FAILED, message)
      return
    }

    if (item === Item.EVIOLITE && pokemon.evolution === Pkm.DEFAULT) {
      client.send(Transfer.DRAG_DROP_FAILED, message)
      return
    }

    if (item === Item.BLACK_AUGURITE && pokemon.passive === Passive.SCYTHER) {
      pokemon.items.add(item) // add the item just in time for the evolution
      pokemon.evolutionRule.tryEvolve(pokemon, player, this.state.stageLevel)
      pokemon.items.delete(item) // retrieve the item, black augurite is not a held item
    }

    if (NonHoldableItems.includes(item) || !pokemon.canHoldItems) {
      client.send(Transfer.DRAG_DROP_FAILED, message)
      return
    }

    const isBasicItem = ItemComponents.includes(item)
    const existingBasicItemToCombine = values(pokemon.items).find((i) =>
      ItemComponents.includes(i)
    )

    // check if full items and nothing to combine
    if (
      pokemon.items.size >= 3 &&
      (!isBasicItem || !existingBasicItemToCombine)
    ) {
      client.send(Transfer.DRAG_DROP_FAILED, message)
      return
    }

    if (
      SynergyItems.includes(item) &&
      pokemon.types.has(SynergyGivenByItem[item]) &&
      pokemon.passive !== Passive.RECYCLE
    ) {
      // prevent adding a synergy stone on a pokemon that already has this synergy
      client.send(Transfer.DRAG_DROP_FAILED, message)
      return
    }

    if (!isBasicItem && pokemon.items.has(item)) {
      // prevent adding twitce the same completed item
      client.send(Transfer.DRAG_DROP_FAILED, message)
      return
    }

    if (item === Item.RARE_CANDY) {
      const evolution = pokemon?.evolution
      if (
        !evolution ||
        evolution === Pkm.DEFAULT ||
        pokemon.items.has(Item.EVIOLITE)
      ) {
        client.send(Transfer.DRAG_DROP_FAILED, message)
        return
      }
      pokemon = player.transformPokemon(pokemon, evolution)
    }

    if (isBasicItem && existingBasicItemToCombine) {
      const recipe = Object.entries(ItemRecipe).find(
        ([_result, recipe]) =>
          (recipe[0] === existingBasicItemToCombine && recipe[1] === item) ||
          (recipe[0] === item && recipe[1] === existingBasicItemToCombine)
      )

      if (!recipe) {
        client.send(Transfer.DRAG_DROP_FAILED, message)
        return
      }

      const itemCombined = recipe[0] as Item

      if (
        itemCombined in SynergyGivenByItem &&
        pokemon.types.has(SynergyGivenByItem[itemCombined])
      ) {
        // prevent combining into a synergy stone on a pokemon that already has this synergy
        client.send(Transfer.DRAG_DROP_FAILED, message)
        return
      }

      pokemon.items.delete(existingBasicItemToCombine)
      removeInArray(player.items, item)

      if (pokemon.items.has(itemCombined)) {
        // pokemon already has the combined item so the second one pops off and go to player inventory
        player.items.push(itemCombined)
      } else {
        pokemon.items.add(itemCombined)
      }
    } else {
      pokemon.items.add(item)
      removeInArray(player.items, item)
    }

    if (pokemon.items.has(Item.SHINY_CHARM)) {
      pokemon.shiny = true
    }

    this.room.checkEvolutionsAfterItemAcquired(playerId, pokemon)

    player.updateSynergies()
  }
}

export class OnSellDropCommand extends Command<
  GameRoom,
  {
    client: Client
    pokemonId: string
  }
> {
  execute({ client, pokemonId }) {
    const player = this.state.players.get(client.auth.uid)

    if (player) {
      const pokemon = player.board.get(pokemonId)
      if (
        pokemon &&
        !isOnBench(pokemon) &&
        this.state.phase === GamePhaseState.FIGHT
      ) {
        return // can't sell a pokemon currently fighting
      }

      if (
        pokemon &&
        canSell(pokemon.name, this.state.specialGameRule) === false
      ) {
        return
      }

      if (pokemon) {
        this.state.shop.releasePokemon(pokemon.name, player)
        const sellPrice = getSellPrice(pokemon, this.state.specialGameRule)
        player.addMoney(sellPrice, false, null)
        pokemon.items.forEach((it) => {
          player.items.push(it)
        })

        player.board.delete(pokemonId)

        player.updateSynergies()
        player.boardSize = this.room.getTeamSize(player.board)
      }
    }
  }
}

export class OnRefreshCommand extends Command<GameRoom, string> {
  execute(id) {
    const player = this.state.players.get(id)
    if (!player) return
    const rollCost = player.shopFreeRolls > 0 ? 0 : 1
    if (player.money >= rollCost && player.alive) {
      this.state.shop.assignShop(player, true, this.state)
      player.money -= rollCost
      player.rerollCount++
      if (player.shopFreeRolls > 0) player.shopFreeRolls--
    }
  }
}

export class OnLockCommand extends Command<GameRoom, string> {
  execute(id) {
    const player = this.state.players.get(id)
    if (player) {
      player.shopLocked = !player.shopLocked
    }
  }
}

export class OnSpectateCommand extends Command<
  GameRoom,
  {
    id: string
    spectatedPlayerId: string
  }
> {
  execute({ id, spectatedPlayerId }) {
    const player = this.state.players.get(id)
    if (player) {
      player.spectatedPlayerId = spectatedPlayerId
    }
  }
}

export class OnLevelUpCommand extends Command<
  GameRoom,
  {
    id: string
  }
> {
  execute(id) {
    const player = this.state.players.get(id)
    if (!player) return

    const cost = getLevelUpCost(this.state.specialGameRule)
    if (player.money >= cost && player.experienceManager.canLevel()) {
      player.experienceManager.addExperience(4)
      player.money -= cost
    }
  }
}

export class OnPickBerryCommand extends Command<
  GameRoom,
  {
    playerId: string
    berryIndex: number
  }
> {
  execute({ playerId, berryIndex }) {
    const player = this.state.players.get(playerId)
    if (player && player.berryTreesStage[berryIndex] >= 3) {
      player.berryTreesStage[berryIndex] = 0
      player.items.push(player.berryTreesType[berryIndex])
      player.berryTreesType[berryIndex] = pickRandomIn(Berries)
    }
  }
}

export class OnJoinCommand extends Command<GameRoom, { client: Client }> {
  async execute({ client }) {
    try {
      //logger.debug("onJoin", client.auth.uid)
      const players = values(this.state.players)
      if (players.some((p) => p.id === client.auth.uid)) {
        /*logger.info(
          `${client.auth.displayName} (${client.id}) joined game room ${this.room.roomId}`
        )*/
        if (this.state.players.size >= MAX_PLAYERS_PER_GAME) {
          const humanPlayers = players.filter((p) => !p.isBot)
          if (humanPlayers.length === 1) {
            humanPlayers[0].titles.add(Title.LONE_WOLF)
          }
        }
      } else {
        this.state.spectators.add(client.auth.uid)
      }
    } catch (error) {
      logger.error(error)
    }
  }
}

export class OnUpdateCommand extends Command<
  GameRoom,
  {
    deltaTime: number
  }
> {
  execute({ deltaTime }) {
    if (deltaTime) {
      this.state.time -= deltaTime
      if (Math.round(this.state.time / 1000) != this.state.roundTime) {
        this.state.roundTime = Math.round(this.state.time / 1000)
      }
      if (this.state.time < 0) {
        this.state.updatePhaseNeeded = true
      } else if (this.state.phase == GamePhaseState.FIGHT) {
        let everySimulationFinished = true

        this.state.simulations.forEach((simulation) => {
          if (!simulation.finished) {
            simulation.update(deltaTime)
            everySimulationFinished = false
          }
        })

        if (everySimulationFinished && !this.state.updatePhaseNeeded) {
          // wait for 3 seconds victory anim before moving to next stage
          this.state.time = 3000
          this.state.updatePhaseNeeded = true
        }
      } else if (this.state.phase === GamePhaseState.MINIGAME) {
        this.room.miniGame.update(deltaTime)
      }
      if (this.state.updatePhaseNeeded && this.state.time < 0) {
        return [new OnUpdatePhaseCommand()]
      }
    }
  }
}

export class OnUpdatePhaseCommand extends Command<GameRoom> {
  execute() {
    this.state.updatePhaseNeeded = false
    if (this.state.phase == GamePhaseState.MINIGAME) {
      this.room.miniGame.stop(this.room)
      this.initializePickingPhase()
    } else if (this.state.phase == GamePhaseState.PICK) {
      this.stopPickingPhase()
      this.checkForLazyTeam()
      this.initializeFightingPhase()
    } else if (this.state.phase == GamePhaseState.FIGHT) {
      this.stopFightingPhase()
      if (
        ItemCarouselStages.includes(this.state.stageLevel) ||
        PortalCarouselStages.includes(this.state.stageLevel)
      ) {
        this.initializeMinigamePhase()
      } else {
        this.initializePickingPhase()
      }
    }
  }

  computeAchievements() {
    this.state.players.forEach((player) => {
      this.checkSuccess(player)
    })
  }

  checkSuccess(player: Player) {
    player.titles.add(Title.NOVICE)
    const effects = this.state.simulations
      .get(player.simulationId)
      ?.getEffects(player.id)
    if (effects) {
      effects.forEach((effect) => {
        switch (effect) {
          case Effect.PURE_POWER:
            player.titles.add(Title.POKEFAN)
            break
          case Effect.SPORE:
            player.titles.add(Title.POKEMON_RANGER)
            break
          case Effect.DESOLATE_LAND:
            player.titles.add(Title.KINDLER)
            break
          case Effect.PRIMORDIAL_SEA:
            player.titles.add(Title.FIREFIGHTER)
            break
          case Effect.POWER_SURGE:
            player.titles.add(Title.ELECTRICIAN)
            break
          case Effect.JUSTIFIED:
            player.titles.add(Title.BLACK_BELT)
            break
          case Effect.EERIE_SPELL:
            player.titles.add(Title.TELEKINESIST)
            break
          case Effect.BEAT_UP:
            player.titles.add(Title.DELINQUENT)
            break
          case Effect.STEEL_SURGE:
            player.titles.add(Title.ENGINEER)
            break
          case Effect.DEEP_MINER:
            player.titles.add(Title.GEOLOGIST)
            break
          case Effect.TOXIC:
            player.titles.add(Title.TEAM_ROCKET_GRUNT)
            break
          case Effect.DRAGON_DANCE:
            player.titles.add(Title.DRAGON_TAMER)
            break
          case Effect.ANGER_POINT:
            player.titles.add(Title.CAMPER)
            break
          case Effect.MERCILESS:
            player.titles.add(Title.MYTH_TRAINER)
            break
          case Effect.CALM_MIND:
            player.titles.add(Title.RIVAL)
            break
          case Effect.WATER_VEIL:
            player.titles.add(Title.DIVER)
            break
          case Effect.HEART_OF_THE_SWARM:
            player.titles.add(Title.BUG_MANIAC)
            break
          case Effect.SKYDIVE:
            player.titles.add(Title.BIRD_KEEPER)
            break
          case Effect.SUN_FLOWER:
            player.titles.add(Title.GARDENER)
            break
          case Effect.GOOGLE_SPECS:
            player.titles.add(Title.ALCHEMIST)
            break
          case Effect.BERSERK:
            player.titles.add(Title.BERSERKER)
            break
          case Effect.ETHEREAL:
            player.titles.add(Title.BLOB)
            break
          case Effect.DIAMOND_STORM:
            player.titles.add(Title.HIKER)
            break
          case Effect.CURSE_OF_FATE:
            player.titles.add(Title.HEX_MANIAC)
            break
          case Effect.MOON_FORCE:
            player.titles.add(Title.CUTE_MANIAC)
            break
          case Effect.SHEER_COLD:
            player.titles.add(Title.SKIER)
            break
          case Effect.FORGOTTEN_POWER:
            player.titles.add(Title.MUSEUM_DIRECTOR)
            break
          case Effect.PRESTO:
            player.titles.add(Title.MUSICIAN)
            break
          case Effect.GOLDEN_EGGS:
            player.titles.add(Title.BABYSITTER)
            break
          case Effect.MAX_ILLUMINATION:
            player.titles.add(Title.CHOSEN_ONE)
            break
          default:
            break
        }
      })
      if (effects.size >= 5) {
        player.titles.add(Title.HARLEQUIN)
      }
      if (effects.size >= 10) {
        player.titles.add(Title.TACTICIAN)
      }
      if (effects.size >= 15) {
        player.titles.add(Title.STRATEGIST)
      }
      let shield = 0
      let heal = 0
      const dpsMeter = this.state.simulations
        .get(player.simulationId)
        ?.getDpsMeter(player.id)

      if (dpsMeter) {
        dpsMeter.forEach((v) => {
          shield += v.shield
          heal += v.heal
        })
      }

      if (shield > 1000) {
        player.titles.add(Title.GARDIAN)
      }
      if (heal > 1000) {
        player.titles.add(Title.NURSE)
      }

      if (this.state.stageLevel >= 40) {
        player.titles.add(Title.ETERNAL)
      }
    }
  }

  checkEndGame() {
    const playersAlive = values(this.state.players).filter((p) => p.alive)

    if (playersAlive.length <= 1) {
      this.state.gameFinished = true
      const winner = playersAlive[0]
      if (winner) {
        /* there is a case where none of the players is alive because
         all the remaining players are dead due to a draw battle.
         In that case, they all already received their rank with checkDeath function */
        const client = this.room.clients.find(
          (cli) => cli.auth.uid === winner.id
        )
        if (client) {
          client.send(Transfer.FINAL_RANK, 1)
        }
      }
      this.clock.setTimeout(() => {
        // dispose the room automatically after 30 seconds
        this.room.broadcast(Transfer.GAME_END)
        this.room.disconnect()
      }, 30 * 1000)
    }
  }

  computeStreak(isPVE: boolean) {
    if (isPVE) return // PVE rounds do not change the current streak
    this.state.players.forEach((player) => {
      if (!player.alive) {
        return
      }

      const [previousBattleResult, lastBattleResult] = player.history
        .filter(
          (stage) => stage.id !== "pve" && stage.result !== BattleResult.DRAW
        )
        .map((stage) => stage.result)
        .slice(-2)

      if (lastBattleResult === BattleResult.DRAW) {
        // preserve existing streak but lose HP
      } else if (lastBattleResult !== previousBattleResult) {
        // reset streak
        player.streak = 0
      } else {
        player.streak += 1
      }
    })
  }

  computeIncome() {
    this.state.players.forEach((player) => {
      let income = 0
      if (player.alive && !player.isBot) {
        player.interest = Math.min(Math.floor(player.money / 10), 5)
        income += player.interest
        income += max(5)(player.streak)
        income += 5
        player.addMoney(income, true, null)
        if (income > 0) {
          const client = this.room.clients.find(
            (cli) => cli.auth.uid === player.id
          )
          client?.send(Transfer.PLAYER_INCOME, income)
        }
        player.experienceManager.addExperience(2)
      }
    })
  }

  checkDeath() {
    this.state.players.forEach((player: Player) => {
      if (player.life <= 0 && player.alive) {
        if (!player.isBot) {
          player.shop.forEach((pkm) => {
            this.state.shop.releasePokemon(pkm, player)
          })
          player.board.forEach((pokemon) => {
            this.state.shop.releasePokemon(pokemon.name, player)
          })
        }
        player.alive = false
        const client = this.room.clients.find(
          (cli) => cli.auth.uid === player.id
        )
        if (client) {
          client.send(Transfer.FINAL_RANK, player.rank)
        }
      }
    })
  }

  initializePickingPhase() {
    this.state.phase = GamePhaseState.PICK
    this.state.time =
      (StageDuration[this.state.stageLevel] ?? StageDuration.DEFAULT) * 1000

    // Item propositions stages
    if (ItemProposalStages.includes(this.state.stageLevel)) {
      this.state.players.forEach((player: Player) => {
        let itemSet = ItemComponents
        if (this.state.specialGameRule === SpecialGameRule.TECHNOLOGIC) {
          itemSet = ArtificialItems.filter(
            (item) => player.artificialItems.includes(item) === false
          )
        }
        resetArraySchema(player.itemsProposition, pickNRandomIn(itemSet, 3))
      })
    }

    // Additional pick stages
    if (AdditionalPicksStages.includes(this.state.stageLevel)) {
      const pool =
        this.state.stageLevel === AdditionalPicksStages[0]
          ? this.room.additionalUncommonPool
          : this.state.stageLevel === AdditionalPicksStages[1]
            ? this.room.additionalRarePool
            : this.room.additionalEpicPool
      let remainingAddPicks = 8
      this.state.players.forEach((player: Player) => {
        if (!player.isBot) {
          const items = pickNRandomIn(ItemComponents, 3)
          for (let i = 0; i < 3; i++) {
            const p = pool.pop()
            if (p) {
              // If the Pokemon has a regional variant in the player's region, show that instead of the base form.
              // Base form will still be added to the pool for all players
              const regionalVariants = (PkmRegionalVariants[p] ?? []).filter(
                (pkm) => new PokemonClasses[pkm]().isInRegion(player.map)
              )
              if (regionalVariants.length > 0) {
                player.pokemonsProposition.push(pickRandomIn(regionalVariants))
              } else {
                player.pokemonsProposition.push(p)
              }
              player.itemsProposition.push(items[i])
            }
          }
          remainingAddPicks--
        }
      })

      repeat(remainingAddPicks)(() => {
        const p = pool.pop()
        if (p) {
          this.state.additionalPokemons.push(p)
          this.state.shop.addAdditionalPokemon(p)
        }
      })

      // update regional pokemons in case some regional variants of add picks are now available
      this.state.players.forEach((p) => p.updateRegionalPool(this.state, false))
    }

    const isAfterPVE = this.state.stageLevel - 1 in PVEStages
    const commands = new Array<Command>()

    this.state.players.forEach((player: Player) => {
      const fireLevel = player.synergies.get(Synergy.FIRE) ?? 0
      const fireSynergLevel = SynergyTriggers[Synergy.FIRE].filter(
        (n) => n <= fireLevel
      ).length
      if (
        fireSynergLevel === 4 &&
        player.items.includes(Item.FIRE_SHARD) === false &&
        player.life > 2
      ) {
        player.items.push(Item.FIRE_SHARD)
      }

      const bestRod = FishingRods.find((rod) => player.items.includes(rod))

      if (bestRod && getFreeSpaceOnBench(player.board) > 0 && !isAfterPVE) {
        const fish = this.state.shop.pickFish(player, bestRod)
        this.room.spawnOnBench(player, fish, "fishing")
      }

      const grassLevel = player.synergies.get(Synergy.GRASS) ?? 0
      const nbTrees = SynergyTriggers[Synergy.GRASS].filter(
        (n) => n <= grassLevel
      ).length
      for (let i = 0; i < nbTrees; i++) {
        player.berryTreesStage[i] = max(3)(player.berryTreesStage[i] + 1)
      }
    })

    this.spawnWanderingPokemons()

    return commands
  }

  checkForLazyTeam() {
    // force move on board some units if room available
    this.state.players.forEach((player, key) => {
      const teamSize = this.room.getTeamSize(player.board)
      const maxTeamSize = getMaxTeamSize(
        player.experienceManager.level,
        this.state.specialGameRule
      )
      if (teamSize < maxTeamSize) {
        const numberOfPokemonsToMove = maxTeamSize - teamSize
        for (let i = 0; i < numberOfPokemonsToMove; i++) {
          const pokemon = values(player.board).find(
            (p) => isOnBench(p) && p.canBePlaced
          )
          const coordinate = getFirstAvailablePositionOnBoard(player.board)
          if (coordinate && pokemon) {
            this.room.swap(player, pokemon, coordinate[0], coordinate[1])
          }
        }
        if (numberOfPokemonsToMove > 0) {
          player.updateSynergies()
        }
      }
    })
  }

  stopPickingPhase() {
    this.state.players.forEach((player) => {
      if (player.pokemonsProposition.length > 0) {
        // auto pick if not chosen
        this.room.pickPokemonProposition(
          player.id,
          pickRandomIn([...player.pokemonsProposition]),
          true
        )
        player.pokemonsProposition.clear()
      } else if (player.itemsProposition.length > 0) {
        // auto pick if not chosen
        this.room.pickItemProposition(
          player.id,
          pickRandomIn([...player.itemsProposition])
        )
        player.itemsProposition.clear()
      }
    })
  }

  stopFightingPhase() {
    const isPVE = this.state.stageLevel in PVEStages

    this.state.simulations.forEach((simulation) => {
      if (!simulation.finished) {
        simulation.onFinish()
      }
      simulation.stop()
    })

    this.computeAchievements()
    this.computeStreak(isPVE)
    this.checkDeath()
    this.computeIncome()

    this.state.players.forEach((player: Player) => {
      if (player.alive) {
        if (player.isBot) {
          player.experienceManager.level = max(9)(
            Math.round(this.state.stageLevel / 2)
          )
        }

        if (isPVE && player.history.at(-1)?.result === BattleResult.WIN) {
          while (player.pveRewards.length > 0) {
            const reward = player.pveRewards.pop()!
            player.items.push(reward)
          }

          if (player.pveRewardsPropositions.length > 0) {
            resetArraySchema(
              player.itemsProposition,
              player.pveRewardsPropositions
            )
            player.pveRewardsPropositions.clear()
          }
        }

        let eggChance = 0
        let shinyChance = 0
        const hasBabyActive =
          player.effects.has(Effect.HATCHER) ||
          player.effects.has(Effect.BREEDER) ||
          player.effects.has(Effect.GOLDEN_EGGS)
        const hasLostLastBattle =
          player.history.at(-1)?.result === BattleResult.DEFEAT

        if (hasLostLastBattle && hasBabyActive) {
          if (player.effects.has(Effect.HATCHER)) {
            eggChance = player.eggChance
            shinyChance = 0
          }
          if (player.effects.has(Effect.BREEDER)) {
            eggChance = 1
            shinyChance = 0
          }
          if (player.effects.has(Effect.GOLDEN_EGGS)) {
            eggChance = 1
            shinyChance = player.eggChance
          }

          player.eggChance = max(1)(player.eggChance + 0.25)
        } else if (!isPVE) {
          player.eggChance = 0
        }

        if (
          this.state.specialGameRule === SpecialGameRule.OMELETTE_COOK &&
          [1, 2, 3].includes(this.state.stageLevel)
        ) {
          eggChance = 1
        }

        const eggsOnBench = values(player.board).filter(
          (p) => p.name === Pkm.EGG
        )
        const nbOfShinyEggs = eggsOnBench.filter((p) => p.shiny).length

        if (chance(eggChance) && getFreeSpaceOnBench(player.board) > 0) {
          const shiny = chance(shinyChance) && nbOfShinyEggs === 0
          const egg = createRandomEgg(shiny, player)
          const x = getFirstAvailablePositionInBench(player.board)
          egg.positionX = x !== undefined ? x : -1
          egg.positionY = 0
          player.board.set(egg.id, egg)
          if (
            player.effects.has(Effect.HATCHER) ||
            (player.effects.has(Effect.GOLDEN_EGGS) && shiny)
          ) {
            player.eggChance = 0
          }
        }

        player.board.forEach((pokemon, key) => {
          if (pokemon.evolutionRule) {
            if (pokemon.evolutionRule instanceof HatchEvolutionRule) {
              pokemon.evolutionRule.updateHatch(
                pokemon,
                player,
                this.state.stageLevel
              )
            }
            if (pokemon.evolutionRule instanceof ConditionBasedEvolutionRule) {
              pokemon.evolutionRule.tryEvolve(
                pokemon,
                player,
                this.state.stageLevel
              )
            }
          }
          if (pokemon.passive === Passive.UNOWN && !isOnBench(pokemon)) {
            // remove after one fight
            player.board.delete(key)
            player.board.delete(pokemon.id)
          }
        })

        // Refreshes effects (Tapu Terrains, or if player lost Psychic 6 after Unown diseappeared)
        player.updateSynergies()

        // Refreshes shop
        if (!player.isBot) {
          if (!player.shopLocked) {
            if (player.shop.every((p) => Unowns.includes(p))) {
              // player stayed on unown shop and did nothing, so we remove its free roll
              player.shopFreeRolls -= 1
            }

            this.state.shop.assignShop(player, false, this.state)
          } else {
            this.state.shop.refillShop(player, this.state)
            player.shopLocked = false
          }
        }
      }
    })

    this.state.stageLevel += 1
    this.checkEndGame()
  }

  initializeMinigamePhase() {
    this.state.phase = GamePhaseState.MINIGAME
    const nbPlayersAlive = values(this.state.players).filter(
      (p) => p.alive
    ).length

    let minigamePhaseDuration = ITEM_CAROUSEL_BASE_DURATION
    if (PortalCarouselStages.includes(this.state.stageLevel)) {
      minigamePhaseDuration = PORTAL_CAROUSEL_BASE_DURATION
    } else if (this.state.stageLevel !== ItemCarouselStages[0]) {
      minigamePhaseDuration += nbPlayersAlive * 2000
    }
    this.state.time = minigamePhaseDuration
    this.room.miniGame.initialize(this.state, this.room)
  }

  initializeFightingPhase() {
    this.state.simulations.clear()
    this.state.phase = GamePhaseState.FIGHT
    this.state.time = FIGHTING_PHASE_DURATION
    this.room.setMetadata({ stageLevel: this.state.stageLevel })
    updateLobby(this.room)
    this.state.botManager.updateBots()

    const pveStage = PVEStages[this.state.stageLevel]

    if (pveStage) {
      this.state.shinyEncounter =
        this.state.specialGameRule === SpecialGameRule.SHINY_HUNTER ||
        chance(pveStage.shinyChance ?? 0)
      this.state.players.forEach((player: Player) => {
        if (player.alive) {
          player.opponentId = "pve"
          player.opponentName = pveStage.name
          player.opponentAvatar = getAvatarString(
            PkmIndex[pveStage.avatar],
            this.state.shinyEncounter,
            pveStage.emotion
          )
          player.opponentTitle = "WILD"
          player.team = Team.BLUE_TEAM

          const rewards = pveStage.getRewards?.(player) ?? ([] as Item[])
          resetArraySchema(player.pveRewards, rewards)

          const rewardsPropositions = this.state.shinyEncounter
            ? pickNRandomIn(ShinyItems, 3)
            : (pveStage.getRewardsPropositions?.(player) ?? ([] as Item[]))

          resetArraySchema(player.pveRewardsPropositions, rewardsPropositions)

          const pveBoard = PokemonFactory.makePveBoard(
            pveStage,
            this.state.shinyEncounter
          )
          const weather = getWeather(player, null, pveBoard)
          const simulation = new Simulation(
            nanoid(),
            this.room,
            player.board,
            pveBoard,
            player,
            undefined,
            this.state.stageLevel,
            weather
          )
          player.simulationId = simulation.id
          this.state.simulations.set(simulation.id, simulation)
        }
      })
    } else {
      const matchups = selectMatchups(this.state)

      matchups.forEach((matchup) => {
        const { bluePlayer, redPlayer } = matchup
        const weather = getWeather(bluePlayer, redPlayer, redPlayer.board)
        const simulationId = nanoid()
        const simulation = new Simulation(
          simulationId,
          this.room,
          bluePlayer.board,
          redPlayer.board,
          bluePlayer,
          redPlayer,
          this.state.stageLevel,
          weather,
          matchup.ghost
        )
        bluePlayer.simulationId = simulationId
        bluePlayer.team = Team.BLUE_TEAM
        bluePlayer.opponents.set(
          redPlayer.id,
          (bluePlayer.opponents.get(redPlayer.id) ?? 0) + 1
        )
        bluePlayer.opponentId = redPlayer.id
        bluePlayer.opponentName = matchup.ghost
          ? `Ghost of ${redPlayer.name}`
          : redPlayer.name
        bluePlayer.opponentAvatar = redPlayer.avatar
        bluePlayer.opponentTitle = redPlayer.title ?? ""

        if (!matchup.ghost) {
          redPlayer.simulationId = simulationId
          redPlayer.team = Team.RED_TEAM
          redPlayer.opponents.set(
            bluePlayer.id,
            (redPlayer.opponents.get(bluePlayer.id) ?? 0) + 1
          )
          redPlayer.opponentId = bluePlayer.id
          redPlayer.opponentName = bluePlayer.name
          redPlayer.opponentAvatar = bluePlayer.avatar
          redPlayer.opponentTitle = bluePlayer.title ?? ""
        }

        this.state.simulations.set(simulation.id, simulation)
      })
    }
  }

  spawnWanderingPokemons() {
    const isPVE = this.state.stageLevel in PVEStages

    this.state.players.forEach((player: Player) => {
      if (player.alive && !player.isBot) {
        const client = this.room.clients.find(
          (cli) => cli.auth.uid === player.id
        )
        if (!client) return

        const UNOWN_ENCOUNTER_CHANCE = 0.037
        if (chance(UNOWN_ENCOUNTER_CHANCE)) {
          setTimeout(
            () => {
              client.send(Transfer.UNOWN_WANDERING)
            },
            Math.round((5 + 15 * Math.random()) * 1000)
          )
        }

        if (
          isPVE &&
          this.state.specialGameRule === SpecialGameRule.GOTTA_CATCH_EM_ALL
        ) {
          const nbPokemonsToSpawn = Math.ceil(this.state.stageLevel / 2)
          for (let i = 0; i < nbPokemonsToSpawn; i++) {
            setTimeout(
              () => {
                client.send(
                  Transfer.POKEMON_WANDERING,
                  this.state.shop.pickPokemon(player, this.state)
                )
              },
              4000 + i * 400
            )
          }
        }
      }
    })
  }
}
