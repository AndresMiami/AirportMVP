/**
 * Household prompts for "Explore this pattern": QUESTIONS to consider when
 * a condition kept being recorded, grouped by where an explanation would
 * place the generator. They are domain vocabulary, not hypotheses; nothing
 * becomes a candidate until the person chooses or writes one, and no
 * prompt is ever balanced in just to fill a heading. Categories here
 * (external condition, resource, incentive, habit, preference, network,
 * institution, feedback loop, slow orientation, shock or selection,
 * combination) are the household's own words; the engine knows only the
 * three loci.
 */
import type { ExplanationCatalogue } from "@/model/domain";

export const HOUSEHOLD_EXPLANATION_CATALOGUE: ExplanationCatalogue = {
  locusLabels: { internal_to_subject: "Person", external_to_subject: "Environment", interaction: "Interaction" },
  prompts: [
    { id: "external_condition", locus: "external_to_subject", question: "Could the work available during these periods have been mostly contract, gig or commission based?", hint: "A persistent condition of the surroundings." },
    { id: "resource_or_constraint", locus: "external_to_subject", question: "Could a limited resource (money, time, transport, childcare) have narrowed the options each time?", hint: "A resource or constraint." },
    { id: "incentive", locus: "external_to_subject", question: "Could the way pay, benefits or rules were set up have rewarded this outcome?", hint: "An incentive." },
    { id: "institutional", locus: "external_to_subject", question: "Could an employer, agency, licence or programme rule have produced the same result each time?", hint: "An institutional condition." },
    { id: "external_shock", locus: "external_to_subject", question: "Did stable arrangements end for reasons outside anyone's control, or were the recorded periods selected in some way?", hint: "External shocks or a selection effect." },
    { id: "relationship_or_network", locus: "interaction", question: "Could who was available to help, refer or share the load have shaped this each time?", hint: "A relationship or network condition." },
    { id: "feedback_loop", locus: "interaction", question: "Could an earlier outcome have fed back into the next one (pressure, fewer options, the same choice again)?", hint: "A feedback loop." },
    { id: "combination", locus: "interaction", question: "Could this only appear when several conditions coincide, and not when one of them is missing?", hint: "A combination or interaction." },
    { id: "habit", locus: "internal_to_subject", question: "Could a settled way of doing things have led here each time, even when other routes were open?", hint: "A habit or tendency." },
    { id: "preference", locus: "internal_to_subject", question: "Was independent or flexible work repeatedly chosen over fixed employment when both were available?", hint: "A preference." },
    { id: "slow_orientation", locus: "internal_to_subject", question: "Does interest tend to move on once something becomes routine or reaches a plateau?", hint: "A slow-changing orientation, a working reading to test, never a label." },
  ],
};
